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

  if (secret && provided !== secret) {
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
        await prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'SUSPENDED',
            savedSdl: deployment.sdlContent,
          },
        })

        try {
          const { getAkashOrchestrator } = await import('../akash/orchestrator.js')
          const orchestrator = getAkashOrchestrator(prisma)
          await orchestrator.closeDeployment(Number(deployment.dseq))
        } catch (err) {
          log.warn({ dseq: deployment.dseq, err }, 'Failed to close Akash deployment on-chain')
        }

        if (deployment.escrow && deployment.escrow.status === 'ACTIVE') {
          await escrowService.pauseEscrow(deployment.id)
        }

        paused.push(`Akash: dseq=${deployment.dseq}`)
      } catch (error) {
        const msg = `Akash ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(msg)
        log.error({ deploymentId: deployment.id, err: error }, 'Failed to pause Akash deployment')
      }
    }

    // 2. Pause Phala deployments: stop CVM
    //    Query through service→project→organization_id (Phala also has organizationId directly, use both)
    const phalaDeployments = await prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { organizationId },
          { service: { project: { organizationId } } },
        ],
      },
    })

    for (const deployment of phalaDeployments) {
      try {
        const { getPhalaOrchestrator } = await import('../phala/orchestrator.js')
        const orchestrator = getPhalaOrchestrator(prisma)
        await orchestrator.stopPhalaDeployment(deployment.appId)

        await prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: { status: 'STOPPED' },
        })

        paused.push(`Phala: ${deployment.name}`)
      } catch (error) {
        const msg = `Phala ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(msg)
        log.error({ deploymentId: deployment.id, err: error }, 'Failed to pause Phala deployment')
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
