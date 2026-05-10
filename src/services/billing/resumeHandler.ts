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
 *   - Spheron STOPPED (with orgBillingId): Re-deploy from
 *     savedCloudInit + savedDeployInput. Spheron has no native start
 *     (the upstream API only exposes create + DELETE), so resume = a
 *     fresh row that inherits the stopped row's recipe + pricing
 *     snapshot. Linked via `resumedFromId` so the user-visible
 *     "Running for Xh" timer keeps walking the chain back to the
 *     original first-active moment instead of resetting to 0 every
 *     pause/resume bounce.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { getEscrowService } from './escrowService.js'
import { scheduleOrEnforcePolicyExpiry } from '../policy/runtimeScheduler.js'
import { createLogger } from '../../lib/logger.js'
import type { SpheronCreateDeploymentInput } from '../spheron/client.js'

const log = createLogger('resume-handler')

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

  if (!secret || provided !== secret) {
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

  log.info(
    { organizationId, balanceCents: newBalanceCents },
    'Checking resume for org'
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

    const pausedSpheron = await prisma.spheronDeployment.findMany({
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
    for (const spheron of pausedSpheron) {
      totalDailyCostCents += (spheron.hourlyRateCents || 0) * 24
    }

    // Only resume if balance covers at least 1 day
    if (newBalanceCents < totalDailyCostCents) {
      log.info(
        { balanceCents: newBalanceCents, dailyCostCents: totalDailyCostCents },
        'Balance below 1-day cost — not resuming'
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          resumed: [],
          reason: 'insufficient_balance',
          balanceCents: newBalanceCents,
          dailyCostCents: totalDailyCostCents,
        })
      )
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
        const { getAkashOrchestrator } =
          await import('../akash/orchestrator.js')
        const orchestrator = getAkashOrchestrator(prisma)

        const newDeploymentId = await orchestrator.deployService(
          deployment.serviceId,
          {
            sdlContent: deployment.savedSdl,
          }
        )

        // Link the new row to the SUSPENDED row so the lease-chain walker
        // can compute a continuous "Running for Xh" timer across the
        // suspend/resume bounce. Without this link the new row is a chain
        // root and the user-visible uptime resets to 0 every topup —
        // which is exactly what triggered the "running for days but the
        // dashboard says 2h" bug. Best-effort: a failure here doesn't
        // break the resume itself, just degrades the timer.
        try {
          await prisma.akashDeployment.update({
            where: { id: newDeploymentId },
            data: { resumedFromId: deployment.id },
          })
        } catch (linkErr) {
          log.warn(
            {
              err: linkErr instanceof Error ? linkErr.message : linkErr,
              newDeploymentId,
              suspendedId: deployment.id,
            },
            'Failed to set resumedFromId on resumed Akash deployment — uptime timer will reset for this row',
          )
        }

        // Preserve policy: create a new policy for the resumed deployment inheriting original constraints
        if (deployment.policyId) {
          const oldPolicy = await prisma.deploymentPolicy.findUnique({
            where: { id: deployment.policyId },
          })
          if (oldPolicy) {
            const newPolicy = await prisma.deploymentPolicy.create({
              data: {
                acceptableGpuModels: oldPolicy.acceptableGpuModels,
                gpuUnits: oldPolicy.gpuUnits,
                gpuVendor: oldPolicy.gpuVendor,
                maxBudgetUsd: oldPolicy.maxBudgetUsd,
                maxMonthlyUsd: oldPolicy.maxMonthlyUsd,
                runtimeMinutes: oldPolicy.runtimeMinutes,
                expiresAt: oldPolicy.runtimeMinutes
                  ? new Date(Date.now() + oldPolicy.runtimeMinutes * 60_000)
                  : null,
                totalSpentUsd: oldPolicy.totalSpentUsd,
              },
            })
            await prisma.akashDeployment.update({
              where: { id: newDeploymentId },
              data: { policyId: newPolicy.id },
            })
          }
        }

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

        // Settle and close the old escrow (don't resume it — that would
        // set it back to ACTIVE and contaminate burn-rate calculations)
        await escrowService.refundEscrow(deployment.id)

        await prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })

        resumed.push(
          `Akash: dseq=${deployment.dseq} → new deployment ${newDeploymentId}`
        )
      } catch (error) {
        errors.push(
          `Akash ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    // Resume Phala deployments
    for (const deployment of pausedPhala) {
      try {
        const { getPhalaOrchestrator } =
          await import('../phala/orchestrator.js')
        const orchestrator = getPhalaOrchestrator(prisma)
        await orchestrator.startPhalaDeployment(deployment.appId)

        // CRITICAL: do NOT overwrite `activeStartedAt` here. From the user's
        // perspective the same workload is coming back online — the
        // "Running for Xh" timer must reflect the original first-active
        // moment, not "right now". The billing logic uses
        // `lastBilledAt || activeStartedAt` to compute charge windows, so
        // updating only `lastBilledAt` is sufficient to make billing pick
        // up from this resume moment without losing the true uptime.
        // (This was previously resetting the timer every topup cycle —
        // see `lib/leaseChain.ts` for the chain-walking counterpart.)
        await prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'ACTIVE',
            lastBilledAt: new Date(),
          },
        })

        // Clear BALANCE_LOW stopReason on policy if resuming
        if (deployment.policyId) {
          await prisma.deploymentPolicy
            .update({
              where: { id: deployment.policyId },
              data: { stopReason: null, stoppedAt: null },
            })
            .catch(err =>
              log.warn(
                { policyId: deployment.policyId, err },
                'Failed to clear policy stopReason on resume'
              )
            )

          await scheduleOrEnforcePolicyExpiry(prisma, deployment.policyId)
        }

        resumed.push(`Phala: ${deployment.name}`)
      } catch (error) {
        errors.push(
          `Phala ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    // Resume Spheron deployments (re-deploy from saved cloudInit + deploy
    // input — Spheron has no native start). Mirrors the Akash pattern more
    // than the Phala one: we spawn a fresh row, link it via resumedFromId
    // so the lease-chain walker keeps the user-visible "Running for Xh"
    // timer continuous, and refund-equivalent the old row by leaving it in
    // STOPPED with the recipe preserved (forensic trail).
    for (const deployment of pausedSpheron) {
      try {
        if (!deployment.savedDeployInput) {
          errors.push(`Spheron ${deployment.id}: no saved deploy input — cannot replay`)
          continue
        }

        const savedInput = deployment.savedDeployInput as unknown as SpheronCreateDeploymentInput

        const { getSpheronOrchestrator } = await import('../spheron/orchestrator.js')
        const { getCachedSpheronSshKeyId } = await import('../providers/spheronSshKeyBootstrap.js')
        const orchestrator = getSpheronOrchestrator(prisma)

        // savedInput.sshKeyId may be missing on rows pre-bootstrap; fall
        // back to the platform-managed key registered at startup. The
        // stopped row's `sshKeyId` column is the most reliable fallback
        // since it's required at insert time.
        const sshKeyId =
          savedInput.sshKeyId || deployment.sshKeyId || getCachedSpheronSshKeyId()
        if (!sshKeyId) {
          errors.push(`Spheron ${deployment.id}: no sshKeyId available — bootstrap not run`)
          continue
        }

        const newDeploymentId = await orchestrator.deployServiceSpheron(
          deployment.serviceId,
          {
            provider: savedInput.provider,
            offerId: savedInput.offerId,
            gpuType: savedInput.gpuType,
            gpuCount: savedInput.gpuCount,
            region: savedInput.region,
            operatingSystem: savedInput.operatingSystem,
            instanceType: savedInput.instanceType,
            sshKeyId,
            // Pricing snapshot from the stopped row — Spheron's live offer
            // pricing may have changed but the user expects to be charged
            // the price they originally signed up for.
            hourlyRateCents: deployment.hourlyRateCents ?? 0,
            originalHourlyRateCents: deployment.originalHourlyRateCents ?? 0,
            marginRate: deployment.marginRate ?? 0,
            pricedSnapshotJson: deployment.pricedSnapshotJson,
            composeContent: deployment.composeContent ?? undefined,
            // envVars are intentionally NOT replayed — `envKeys` records
            // only the keys, not the values. Resume preserves the same
            // recipe shape but a true env-value resume would need secret
            // storage outside Spheron (Phase 2).
            envVars: undefined,
            orgBillingId,
            organizationId,
            policyId: undefined,
            // Mirror the Akash pattern: a fresh policy clone if the
            // stopped row had one, so runtime caps + budget caps reset
            // their accounting against the new lifetime window.
          },
        )

        // Phase 49b lease-chain — link the new row to the STOPPED row so
        // the user-visible "Running for Xh" timer keeps walking back to
        // the original first-active moment. Best-effort: a failure here
        // doesn't break the resume itself, just degrades the timer.
        try {
          await prisma.spheronDeployment.update({
            where: { id: newDeploymentId },
            data: { resumedFromId: deployment.id },
          })
        } catch (linkErr) {
          log.warn(
            {
              err: linkErr instanceof Error ? linkErr.message : linkErr,
              newDeploymentId,
              stoppedId: deployment.id,
            },
            'Failed to set resumedFromId on resumed Spheron deployment — uptime timer will reset for this row',
          )
        }

        // Preserve policy: clone with same constraints + reset
        // expiresAt window. Mirror of the Akash policy-clone path.
        if (deployment.policyId) {
          try {
            const oldPolicy = await prisma.deploymentPolicy.findUnique({
              where: { id: deployment.policyId },
            })
            if (oldPolicy) {
              const newPolicy = await prisma.deploymentPolicy.create({
                data: {
                  acceptableGpuModels: oldPolicy.acceptableGpuModels,
                  gpuUnits: oldPolicy.gpuUnits,
                  gpuVendor: oldPolicy.gpuVendor,
                  maxBudgetUsd: oldPolicy.maxBudgetUsd,
                  maxMonthlyUsd: oldPolicy.maxMonthlyUsd,
                  runtimeMinutes: oldPolicy.runtimeMinutes,
                  expiresAt: oldPolicy.runtimeMinutes
                    ? new Date(Date.now() + oldPolicy.runtimeMinutes * 60_000)
                    : null,
                  totalSpentUsd: oldPolicy.totalSpentUsd,
                },
              })
              await prisma.spheronDeployment.update({
                where: { id: newDeploymentId },
                data: { policyId: newPolicy.id },
              })
              await scheduleOrEnforcePolicyExpiry(prisma, newPolicy.id)
            }
          } catch (policyErr) {
            log.warn(
              {
                err: policyErr instanceof Error ? policyErr.message : policyErr,
                stoppedId: deployment.id,
              },
              'Failed to clone Spheron policy on resume — new row has no policy',
            )
          }
        }

        resumed.push(`Spheron: ${deployment.name} → new deployment ${newDeploymentId}`)
      } catch (error) {
        errors.push(
          `Spheron ${deployment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    log.info(
      { resumedCount: resumed.length, errorCount: errors.length },
      'Resume check completed'
    )

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ resumed, errors }))
  } catch (error) {
    log.error(error, 'Fatal error')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal error' }))
  }
}
