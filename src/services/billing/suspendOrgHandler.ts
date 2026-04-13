/**
 * Org Suspension Handler
 *
 * Called by auth service (via internal API) when a subscription becomes SUSPENDED.
 * Pauses all active Akash and Phala deployments for the organization.
 *
 * Pause logic:
 *   - Akash ACTIVE: Save SDL, close on-chain, mark SUSPENDED, pause escrow
 *   - Phala ACTIVE: Stop CVM via API, mark STOPPED
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { getEscrowService } from './escrowService.js'
import {
  processFinalPhalaBilling,
  settleAkashEscrowToTime,
} from './deploymentSettlement.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('suspend-org-handler')

interface SuspendRequest {
  organizationId: string
}

/**
 * Handle POST /internal/compute/suspend-org
 */
export async function handleSuspendOrg(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
) {
  const secret = process.env.AUTH_INTROSPECTION_SECRET
  const provided = req.headers['x-af-introspection-secret'] as string

  if (!secret || provided !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  let body: SuspendRequest
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const { organizationId } = body

  if (!organizationId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing organizationId' }))
    return
  }

  log.info({ organizationId }, 'Suspending all deployments for org')

  const paused: string[] = []
  const errors: string[] = []

  try {
    const escrowService = getEscrowService(prisma)

    // 1. Pause Akash deployments: close on-chain, save SDL, mark SUSPENDED
    //    Query through service→project→organization_id (not escrow, which may not exist)
    const akashDeployments = await prisma.akashDeployment.findMany({
      where: {
        status: 'ACTIVE',
        service: { project: { organizationId } },
      },
      include: { escrow: true },
    })

    for (const deployment of akashDeployments) {
      try {
        const stoppedAt = new Date()

        // Save SDL first — needed for eventual resume regardless of close outcome
        await prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { savedSdl: deployment.sdlContent },
        })

        // Close on-chain BEFORE marking DB state as SUSPENDED.
        // If close fails, the deployment stays ACTIVE and billed until resolved.
        let onChainClosed = false
        try {
          const { getAkashOrchestrator } =
            await import('../akash/orchestrator.js')
          const orchestrator = getAkashOrchestrator(prisma)
          log.info({ dseq: deployment.dseq }, 'Closing on-chain deployment for org suspension')
          await orchestrator.closeDeployment(Number(deployment.dseq))
          onChainClosed = true
          log.info({ dseq: deployment.dseq }, 'On-chain close TX submitted')
          // Wait for TX to settle before closing the next one — avoids sequence number collisions
          await new Promise(r => setTimeout(r, 8000))
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const alreadyGone = /deployment not found|deployment closed|not active|does not exist|order not found|lease not found|unknown deployment|invalid deployment/i.test(errMsg)
          if (alreadyGone) {
            log.warn({ dseq: deployment.dseq, err }, 'On-chain deployment already gone — treating as closed')
            onChainClosed = true
          } else {
            log.error(
              { dseq: deployment.dseq, err },
              'On-chain close FAILED — deployment stays ACTIVE and billed until resolved'
            )
            errors.push(
              `Akash dseq=${deployment.dseq}: on-chain close failed, still running and billed`
            )
          }
        }

        if (onChainClosed) {
          await prisma.akashDeployment.update({
            where: { id: deployment.id },
            data: { status: 'SUSPENDED' },
          })

          if (deployment.policyId) {
            await prisma.deploymentPolicy
              .update({
                where: { id: deployment.policyId },
                data: { stopReason: 'BALANCE_LOW', stoppedAt },
              })
              .catch(err =>
                log.warn(
                  { policyId: deployment.policyId, err },
                  'Failed to set policy stopReason'
                )
              )
          }

          if (deployment.escrow && deployment.escrow.status === 'ACTIVE') {
            await settleAkashEscrowToTime(prisma, deployment.id, stoppedAt)
            await escrowService.pauseEscrow(deployment.id)
          }

          paused.push(`Akash: dseq=${deployment.dseq}`)
        }
      } catch (error) {
        const msg = `Akash ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(msg)
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Akash deployment'
        )
      }
    }

    // 2. Pause Phala deployments: stop CVM
    //    Query through service→project→organization_id (Phala also has organizationId directly, use both)
    const phalaDeployments = await prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ organizationId }, { service: { project: { organizationId } } }],
      },
    })

    for (const deployment of phalaDeployments) {
      try {
        const stoppedAt = new Date()
        await processFinalPhalaBilling(
          prisma,
          deployment.id,
          stoppedAt,
          'phala_balance_low_suspend'
        )

        const { getPhalaOrchestrator } =
          await import('../phala/orchestrator.js')
        const orchestrator = getPhalaOrchestrator(prisma)
        await orchestrator.stopPhalaDeployment(deployment.appId)

        await prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: { status: 'STOPPED' },
        })

        // Mark policy stop reason as BALANCE_LOW if policy exists
        if (deployment.policyId) {
          await prisma.deploymentPolicy
            .update({
              where: { id: deployment.policyId },
              data: { stopReason: 'BALANCE_LOW', stoppedAt: new Date() },
            })
            .catch(err =>
              log.warn(
                { policyId: deployment.policyId, err },
                'Failed to set policy stopReason'
              )
            )
        }

        paused.push(`Phala: ${deployment.name}`)
      } catch (error) {
        const msg = `Phala ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(msg)
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Phala deployment'
        )
      }
    }

    log.info(
      { organizationId, pausedCount: paused.length, errorCount: errors.length },
      'Org suspension complete'
    )

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ paused, errors }))
  } catch (error) {
    log.error(error, 'Fatal error in suspend-org handler')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal error' }))
  }
}
