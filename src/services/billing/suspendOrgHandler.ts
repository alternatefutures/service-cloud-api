/**
 * Org Suspension Handler
 *
 * Called by auth service (via internal API) when a subscription becomes SUSPENDED.
 * Pauses all active Akash, Phala, and Spheron deployments for the organization.
 *
 * Pause logic:
 *   - Akash ACTIVE: Save SDL, close on-chain, mark SUSPENDED, pause escrow
 *   - Phala ACTIVE: Stop CVM via API, mark STOPPED
 *   - Spheron ACTIVE: Settle final billing (with 20-min floor), DELETE
 *     upstream VM (deferred via sweeper if inside 20-min floor), mark STOPPED
 *     locally with savedCloudInit + savedDeployInput preserved for resume.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { getEscrowService } from './escrowService.js'
import {
  processFinalPhalaBilling,
  processFinalSpheronBilling,
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
          // Sequence-settle delay is held inside withWalletLock
          // (see services/akash/walletMutex.ts). No manual sleep needed.
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

    // 3. Pause Spheron deployments. No native stop — DELETE the VM and
    //    preserve savedCloudInit / savedDeployInput on the row so resume
    //    can re-deploy. The 20-min minimum-runtime floor is handled via
    //    isMinimumRuntimeNotMet: settle billing + mark STOPPED + leave the
    //    upstream cleanup to the sweeper (`reconcileSpheronUpstreamCleanups`).
    const spheronDeployments = await prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ organizationId }, { service: { project: { organizationId } } }],
      },
    })

    for (const deployment of spheronDeployments) {
      try {
        const stoppedAt = new Date()

        // Settle billing BEFORE the upstream DELETE. The 20-min floor
        // is enforced inside processFinalSpheronBilling.
        await processFinalSpheronBilling(
          prisma,
          deployment.id,
          stoppedAt,
          'spheron_balance_low_suspend'
        )

        let providerStopped = false
        let upstreamDeletedAt: Date | null = null

        if (deployment.providerDeploymentId) {
          try {
            const { getSpheronOrchestrator } = await import('../spheron/orchestrator.js')
            const orchestrator = getSpheronOrchestrator(prisma)
            await orchestrator.closeDeployment(deployment.providerDeploymentId)
            upstreamDeletedAt = new Date()
            providerStopped = true
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            const { SpheronApiError } = await import('../spheron/client.js')
            if (err instanceof SpheronApiError && err.isAlreadyGone()) {
              log.warn(
                { providerDeploymentId: deployment.providerDeploymentId, err },
                'Spheron VM already gone during org suspend — treating as stopped'
              )
              upstreamDeletedAt = new Date()
              providerStopped = true
            } else if (
              err instanceof SpheronApiError &&
              err.isMinimumRuntimeNotMet()
            ) {
              log.warn(
                { providerDeploymentId: deployment.providerDeploymentId },
                'Spheron DELETE deferred (minimum runtime) during org suspend — sweeper will retry'
              )
              providerStopped = true
            } else {
              log.error(
                { deploymentId: deployment.id, err: errMsg },
                'Spheron DELETE failed during org suspend — deployment stays ACTIVE and billed'
              )
              errors.push(
                `Spheron ${deployment.id}: DELETE failed, still running and billed`
              )
            }
          }
        } else {
          // No upstream id — nothing to delete, treat as stopped.
          upstreamDeletedAt = new Date()
          providerStopped = true
        }

        if (providerStopped) {
          await prisma.spheronDeployment.update({
            where: { id: deployment.id },
            data: {
              status: 'STOPPED',
              ...(upstreamDeletedAt ? { upstreamDeletedAt } : {}),
            },
          })

          if (deployment.policyId) {
            await prisma.deploymentPolicy
              .update({
                where: { id: deployment.policyId },
                data: { stopReason: 'BALANCE_LOW', stoppedAt },
              })
              .catch((err) =>
                log.warn(
                  { policyId: deployment.policyId, err },
                  'Failed to set Spheron policy stopReason'
                )
              )
          }

          paused.push(`Spheron: ${deployment.name}`)
        }
      } catch (error) {
        const msg = `Spheron ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(msg)
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Spheron deployment'
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
