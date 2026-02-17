/**
 * Compute Resume Handler
 *
 * Called by auth service (via internal API) after a wallet topup event.
 * Checks if any suspended/stopped deployments for the org can be resumed
 * based on the new balance.
 *
 * Resume logic:
 *   - Akash SUSPENDED: Re-deploy from savedSdl, create new escrow
 *   - Phala STOPPED (with orgBillingId): Start CVM, resume billing
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { getEscrowService } from './escrowService.js'

interface ResumeRequest {
  orgBillingId: string
  organizationId: string
  newBalanceCents: number
}

/**
 * Handle POST /internal/compute/check-resume
 */
export async function handleComputeResumeCheck(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
) {
  // Verify introspection secret
  const secret = process.env.AUTH_INTROSPECTION_SECRET
  const provided = req.headers['x-af-introspection-secret'] as string

  if (secret && provided !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  // Parse body
  let body: ResumeRequest
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

  const { orgBillingId, organizationId, newBalanceCents } = body

  if (!orgBillingId || !organizationId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing orgBillingId or organizationId' }))
    return
  }

  console.log(
    `[ResumeHandler] Checking resume for org ${organizationId} ` +
    `(balance: $${(newBalanceCents / 100).toFixed(2)})`
  )

  const resumed: string[] = []
  const errors: string[] = []

  try {
    // Calculate total daily cost for paused deployments
    const pausedEscrows = await prisma.deploymentEscrow.findMany({
      where: {
        orgBillingId,
        status: 'PAUSED',
      },
      include: {
        akashDeployment: true,
      },
    })

    const pausedPhala = await prisma.phalaDeployment.findMany({
      where: {
        orgBillingId,
        status: 'STOPPED',
      },
    })

    // Estimate total daily cost if all resume
    let totalDailyCostCents = 0
    for (const escrow of pausedEscrows) {
      totalDailyCostCents += escrow.dailyRateCents
    }
    for (const phala of pausedPhala) {
      totalDailyCostCents += (phala.hourlyRateCents || 0) * 24
    }

    // Only resume if balance covers at least 1 day
    if (newBalanceCents < totalDailyCostCents) {
      console.log(
        `[ResumeHandler] Balance $${(newBalanceCents / 100).toFixed(2)} ` +
        `< 1 day cost $${(totalDailyCostCents / 100).toFixed(2)}. Not resuming.`
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        resumed: [],
        reason: 'insufficient_balance',
        balanceCents: newBalanceCents,
        dailyCostCents: totalDailyCostCents,
      }))
      return
    }

    // Resume Akash deployments
    const escrowService = getEscrowService(prisma)
    for (const escrow of pausedEscrows) {
      const deployment = escrow.akashDeployment
      if (!deployment || !deployment.savedSdl) {
        errors.push(`Akash ${deployment?.id}: no saved SDL`)
        continue
      }

      try {
        // Re-deploy from saved SDL
        const { getAkashOrchestrator } = await import('../akash/orchestrator.js')
        const orchestrator = getAkashOrchestrator(prisma)

        const newDeploymentId = await orchestrator.deployService(deployment.serviceId, {
          sdlContent: deployment.savedSdl,
        })

        // Create new escrow for the new deployment
        const billingApi = getBillingApiClient()
        const orgMarkup = await billingApi.getOrgMarkup(orgBillingId)

        // The new deployment has its own pricePerBlock from the bid
        const newDeployment = await prisma.akashDeployment.findUnique({
          where: { id: newDeploymentId },
        })

        if (newDeployment?.pricePerBlock) {
          await escrowService.createEscrow({
            akashDeploymentId: newDeploymentId,
            organizationId,
            pricePerBlock: newDeployment.pricePerBlock,
            marginRate: orgMarkup.marginRate,
            userId: 'system',
          })
        }

        // Mark old escrow as refunded (already consumed)
        await escrowService.resumeEscrow(deployment.id)

        // Clean up the old suspended deployment
        await prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })

        resumed.push(`Akash: dseq=${deployment.dseq} → new deployment ${newDeploymentId}`)
      } catch (error) {
        errors.push(`Akash ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Resume Phala deployments
    for (const deployment of pausedPhala) {
      try {
        const { getPhalaOrchestrator } = await import('../phala/orchestrator.js')
        const orchestrator = getPhalaOrchestrator(prisma)
        await orchestrator.startPhalaDeployment(deployment.appId)

        await prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'ACTIVE',
            activeStartedAt: new Date(),
            lastBilledAt: new Date(),
          },
        })

        resumed.push(`Phala: ${deployment.name}`)
      } catch (error) {
        errors.push(`Phala ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    console.log(`[ResumeHandler] Resumed ${resumed.length} deployments, ${errors.length} errors`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ resumed, errors }))
  } catch (error) {
    console.error('[ResumeHandler] Fatal error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal error' }))
  }
}
