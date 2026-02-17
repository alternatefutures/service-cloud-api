/**
 * Compute Billing Scheduler
 *
 * Daily cron job (3 AM) that processes:
 *   1. Akash escrow daily consumption
 *   2. Phala per-hour debits
 *   3. Balance threshold checks → pause if < 1 day burn
 *
 * Follows the same pattern as InvoiceScheduler and StorageSnapshotScheduler.
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { getEscrowService } from './escrowService.js'
import { getBillingApiClient } from './billingApiClient.js'
import { getPhalaHourlyRate, applyMargin } from '../../config/pricing.js'

export class ComputeBillingScheduler {
  private cronJob: cron.ScheduledTask | null = null
  private forceMode = false
  private noPauseMode = false

  constructor(private prisma: PrismaClient) {}

  /**
   * Start the scheduler — runs daily at 3 AM (after InvoiceScheduler at 2 AM)
   */
  start() {
    if (this.cronJob) {
      console.log('[ComputeBilling] Already running')
      return
    }

    this.cronJob = cron.schedule('0 3 * * *', async () => {
      await this.runBillingCycle()
    })

    console.log('[ComputeBilling] Started — runs daily at 3 AM')
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      console.log('[ComputeBilling] Stopped')
    }
  }

  /**
   * Run billing cycle immediately (for testing / manual trigger)
   * @param options.force — bypasses the hoursSinceLastBill minimum check
   * @param options.noPause — skips the threshold check → pause flow (safe for testing)
   */
  async runNow(options: { force?: boolean; noPause?: boolean } | boolean = false) {
    // Back-compat: accept bare boolean for force
    const opts = typeof options === 'boolean' ? { force: options, noPause: false } : options
    this.forceMode = opts.force ?? false
    this.noPauseMode = opts.noPause ?? false

    const flags = [
      opts.force ? 'FORCE' : null,
      opts.noPause ? 'NO-PAUSE' : null,
    ].filter(Boolean).join(', ')

    console.log('[ComputeBilling] Manual trigger — running billing cycle now' + (flags ? ` (${flags})` : ''))
    try {
      await this.runBillingCycle()
    } finally {
      this.forceMode = false
      this.noPauseMode = false
    }
  }

  // ========================================
  // MAIN BILLING CYCLE
  // ========================================

  private async runBillingCycle() {
    const startTime = Date.now()
    console.log('[ComputeBilling] Starting daily billing cycle...')

    const stats = {
      akashProcessed: 0,
      akashErrors: 0,
      phalaProcessed: 0,
      phalaErrors: 0,
      orgsPaused: 0,
      totalDebitedCents: 0,
    }

    try {
      // Step 1: Process Akash escrow daily consumption
      await this.processAkashEscrows(stats)

      // Step 2: Process Phala hourly debits
      await this.processPhalaDebits(stats)

      // Step 3: Check balance thresholds and pause if needed
      if (this.noPauseMode) {
        console.log('[ComputeBilling] Skipping threshold/pause check (--no-pause mode)')
      } else {
        await this.checkThresholds(stats)
      }

      const duration = Date.now() - startTime
      console.log(
        `[ComputeBilling] Cycle complete: ` +
        `Akash=${stats.akashProcessed} (${stats.akashErrors} err), ` +
        `Phala=${stats.phalaProcessed} (${stats.phalaErrors} err), ` +
        `Paused=${stats.orgsPaused} orgs, ` +
        `Debited=$${(stats.totalDebitedCents / 100).toFixed(2)}, ` +
        `Duration=${duration}ms`
      )
    } catch (error) {
      console.error('[ComputeBilling] Fatal error in billing cycle:', error)
    }
  }

  // ========================================
  // STEP 1: AKASH ESCROW CONSUMPTION
  // ========================================

  private async processAkashEscrows(stats: {
    akashProcessed: number
    akashErrors: number
    totalDebitedCents: number
  }) {
    const escrowService = getEscrowService(this.prisma)

    const activeEscrows = await this.prisma.deploymentEscrow.findMany({
      where: { status: 'ACTIVE' },
      include: { akashDeployment: { select: { id: true, status: true } } },
    })

    console.log(`[ComputeBilling] Processing ${activeEscrows.length} active Akash escrows`)

    for (const escrow of activeEscrows) {
      try {
        // Skip if deployment is no longer active
        if (escrow.akashDeployment.status !== 'ACTIVE') {
          console.log(`[ComputeBilling] Akash escrow ${escrow.id}: deployment status=${escrow.akashDeployment.status} — skipping`)
          continue
        }

        console.log(
          `[ComputeBilling] Akash escrow ${escrow.id}: ` +
          `deployment=${escrow.akashDeploymentId}, rate=$${(escrow.dailyRateCents / 100).toFixed(2)}/day, ` +
          `consumed=$${(escrow.consumedCents / 100).toFixed(2)}/${(escrow.depositCents / 100).toFixed(2)}`
        )

        const updated = await escrowService.processDailyConsumption(escrow.id, this.forceMode)

        if (updated) {
          stats.akashProcessed++
          stats.totalDebitedCents += escrow.dailyRateCents
          console.log(`[ComputeBilling] Akash escrow ${escrow.id}: ✅ consumed $${(escrow.dailyRateCents / 100).toFixed(2)}`)
        } else {
          console.log(`[ComputeBilling] Akash escrow ${escrow.id}: skipped (too soon since last billing or not active)`)
        }
      } catch (error) {
        stats.akashErrors++
        console.error(
          `[ComputeBilling] Akash escrow ${escrow.id} error:`,
          error instanceof Error ? error.message : error
        )
      }
    }
  }

  // ========================================
  // STEP 2: PHALA PER-HOUR DEBITS
  // ========================================

  private async processPhalaDebits(stats: {
    phalaProcessed: number
    phalaErrors: number
    totalDebitedCents: number
  }) {
    const billingApi = getBillingApiClient()

    const activePhala = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId: { not: null },
        hourlyRateCents: { not: null },
      },
    })

    console.log(`[ComputeBilling] Processing ${activePhala.length} active Phala deployments`)

    const now = new Date()

    for (const deployment of activePhala) {
      try {
        if (!deployment.orgBillingId || !deployment.hourlyRateCents) {
          console.log(`[ComputeBilling] Phala ${deployment.id}: missing orgBillingId or hourlyRateCents — skipping`)
          continue
        }

        // Calculate billable hours since last billing
        const lastBilled = deployment.lastBilledAt || deployment.activeStartedAt || deployment.createdAt
        const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

        console.log(
          `[ComputeBilling] Phala ${deployment.id}: ` +
          `lastBilled=${lastBilled.toISOString()}, hoursSince=${hoursSinceLastBill.toFixed(2)}, ` +
          `rate=$${(deployment.hourlyRateCents / 100).toFixed(2)}/hr, orgBilling=${deployment.orgBillingId}`
        )

        // Don't bill if less than 1 hour since last billing (skip in force mode)
        if (hoursSinceLastBill < 1 && !this.forceMode) {
          console.log(`[ComputeBilling] Phala ${deployment.id}: <1h since last bill — skipping (use --force to override)`)
          continue
        }

        // In force mode with <1 hour, bill for at least 1 hour
        const billableHours = this.forceMode ? Math.max(1, Math.floor(hoursSinceLastBill)) : Math.floor(hoursSinceLastBill)
        const amountCents = billableHours * deployment.hourlyRateCents

        if (amountCents <= 0) {
          console.log(`[ComputeBilling] Phala ${deployment.id}: amountCents=0 — skipping`)
          continue
        }

        const dateKey = now.toISOString().slice(0, 10)
        const runId = this.forceMode ? `force_${Date.now()}` : dateKey
        const idempotencyKey = `phala_daily:${deployment.id}:${runId}`

        console.log(
          `[ComputeBilling] Phala ${deployment.id}: billing ${billableHours}h × $${(deployment.hourlyRateCents / 100).toFixed(2)} = $${(amountCents / 100).toFixed(2)}`
        )

        const result = await billingApi.computeDebit({
          orgBillingId: deployment.orgBillingId,
          amountCents,
          serviceType: 'phala_tee',
          provider: 'phala',
          resource: deployment.id,
          description: `Phala TEE ${deployment.cvmSize || 'tdx.large'}: ${billableHours}h @ $${(deployment.hourlyRateCents / 100).toFixed(2)}/hr`,
          idempotencyKey,
        })

        if (result.alreadyProcessed) {
          console.log(`[ComputeBilling] Phala ${deployment.id}: already processed (idempotency hit)`)
        } else {
          // Update Phala deployment billing state
          await this.prisma.phalaDeployment.update({
            where: { id: deployment.id },
            data: {
              lastBilledAt: now,
              totalBilledCents: deployment.totalBilledCents + amountCents,
            },
          })

          stats.phalaProcessed++
          stats.totalDebitedCents += amountCents
          console.log(`[ComputeBilling] Phala ${deployment.id}: ✅ debited $${(amountCents / 100).toFixed(2)}`)
        }
      } catch (error) {
        stats.phalaErrors++
        const errMsg = error instanceof Error ? error.message : String(error)

        // If insufficient balance, mark for pausing (handled in threshold check)
        if (errMsg.includes('INSUFFICIENT_BALANCE')) {
          console.warn(`[ComputeBilling] Phala ${deployment.id}: insufficient balance — will pause`)
        } else {
          console.error(`[ComputeBilling] Phala ${deployment.id} error:`, errMsg)
          // Log the full error in debug mode
          if (error instanceof Error && error.stack) {
            console.error(`[ComputeBilling] Stack:`, error.stack)
          }
          if ((error as any).body) {
            console.error(`[ComputeBilling] Response body:`, JSON.stringify((error as any).body))
          }
        }
      }
    }
  }

  // ========================================
  // STEP 3: THRESHOLD CHECK → PAUSE
  // ========================================

  private async checkThresholds(stats: { orgsPaused: number }) {
    const billingApi = getBillingApiClient()
    const escrowService = getEscrowService(this.prisma)

    // Collect unique orgBillingIds from active deployments
    const orgBillingIds = new Set<string>()

    const activeEscrows = await this.prisma.deploymentEscrow.findMany({
      where: { status: 'ACTIVE' },
      select: { orgBillingId: true, organizationId: true, dailyRateCents: true },
    })

    const activePhala = await this.prisma.phalaDeployment.findMany({
      where: { status: 'ACTIVE', orgBillingId: { not: null } },
      select: { orgBillingId: true, organizationId: true, hourlyRateCents: true },
    })

    // Build per-org burn rates
    const orgBurnRates = new Map<string, { dailyCostCents: number; orgId: string }>()

    for (const e of activeEscrows) {
      const existing = orgBurnRates.get(e.orgBillingId) || { dailyCostCents: 0, orgId: e.organizationId }
      existing.dailyCostCents += e.dailyRateCents
      orgBurnRates.set(e.orgBillingId, existing)
    }

    for (const p of activePhala) {
      if (!p.orgBillingId || !p.hourlyRateCents) continue
      const existing = orgBurnRates.get(p.orgBillingId) || { dailyCostCents: 0, orgId: p.organizationId || '' }
      existing.dailyCostCents += p.hourlyRateCents * 24 // Convert hourly to daily
      orgBurnRates.set(p.orgBillingId, existing)
    }

    // Check each org's balance against 1-day burn
    for (const [orgBillingId, { dailyCostCents, orgId }] of orgBurnRates) {
      try {
        const balanceInfo = await billingApi.getOrgBalance(orgBillingId)

        if (balanceInfo.balanceCents < dailyCostCents) {
          console.warn(
            `[ComputeBilling] Org ${orgId} balance ($${(balanceInfo.balanceCents / 100).toFixed(2)}) ` +
            `< 1 day burn ($${(dailyCostCents / 100).toFixed(2)}). PAUSING deployments.`
          )

          await this.pauseOrgDeployments(orgBillingId, orgId, balanceInfo.balanceCents, dailyCostCents)
          stats.orgsPaused++
        }
      } catch (error) {
        console.error(`[ComputeBilling] Threshold check failed for org ${orgBillingId}:`, error)
      }
    }
  }

  // ========================================
  // PAUSE FLOW
  // ========================================

  /**
   * Pause all deployments for an org due to insufficient balance
   */
  private async pauseOrgDeployments(
    orgBillingId: string,
    orgId: string,
    balanceCents: number,
    dailyCostCents: number
  ) {
    const billingApi = getBillingApiClient()
    const escrowService = getEscrowService(this.prisma)
    const pausedServices: string[] = []

    // 1. Pause Akash deployments: close on-chain, save SDL, mark SUSPENDED
    const akashDeployments = await this.prisma.akashDeployment.findMany({
      where: {
        status: 'ACTIVE',
        escrow: { orgBillingId, status: 'ACTIVE' },
      },
      include: { escrow: true },
    })

    for (const deployment of akashDeployments) {
      try {
        // Save SDL for later re-deploy
        await this.prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'SUSPENDED',
            savedSdl: deployment.sdlContent, // Save for resume
          },
        })

        // Close on-chain (Akash has no native pause)
        try {
          const { getAkashOrchestrator } = await import('../akash/orchestrator.js')
          const orchestrator = getAkashOrchestrator(this.prisma)
          await orchestrator.closeDeployment(Number(deployment.dseq))
        } catch (err) {
          console.warn(`[ComputeBilling] Failed to close Akash dseq=${deployment.dseq} on-chain:`, err)
        }

        // Pause escrow
        if (deployment.escrow) {
          await escrowService.pauseEscrow(deployment.id)
        }

        pausedServices.push(`Akash: dseq=${deployment.dseq}`)
      } catch (error) {
        console.error(`[ComputeBilling] Failed to pause Akash ${deployment.id}:`, error)
      }
    }

    // 2. Pause Phala deployments: stop CVM (Phala supports native stop/start)
    const phalaDeployments = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId,
      },
    })

    for (const deployment of phalaDeployments) {
      try {
        const { getPhalaOrchestrator } = await import('../phala/orchestrator.js')
        const orchestrator = getPhalaOrchestrator(this.prisma)
        await orchestrator.stopPhalaDeployment(deployment.appId)

        await this.prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: { status: 'STOPPED' },
        })

        pausedServices.push(`Phala: ${deployment.name}`)
      } catch (error) {
        console.error(`[ComputeBilling] Failed to pause Phala ${deployment.id}:`, error)
      }
    }

    // 3. Send notification email
    if (pausedServices.length > 0) {
      try {
        // TODO: look up org admin email (for now, use a best-effort approach)
        // This would need an internal API call to get org members
        await billingApi.notify({
          orgId,
          type: 'low_balance_pause',
          email: '', // Filled by auth service from org admin lookup
          balanceCents,
          dailyCostCents,
          pausedServices,
        })
      } catch (error) {
        console.error(`[ComputeBilling] Failed to send pause notification for org ${orgId}:`, error)
      }
    }
  }
}

// Singleton
let instance: ComputeBillingScheduler | null = null

export function getComputeBillingScheduler(prisma: PrismaClient): ComputeBillingScheduler {
  if (!instance) {
    instance = new ComputeBillingScheduler(prisma)
  }
  return instance
}
