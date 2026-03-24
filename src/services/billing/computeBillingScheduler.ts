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
import { createLogger } from '../../lib/logger.js'

const log = createLogger('compute-billing')

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
      log.info('Already running')
      return
    }

    this.cronJob = cron.schedule('0 3 * * *', async () => {
      await this.runBillingCycle()
    })

    log.info('Started — runs daily at 3 AM')
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
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

    log.info({ flags: flags || undefined }, 'Manual trigger — running billing cycle now')
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
    log.info('Starting daily billing cycle')

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
        log.info('Skipping threshold/pause check (no-pause mode)')
      } else {
        await this.checkThresholds(stats)
      }

      const duration = Date.now() - startTime
      log.info(
        {
          akashProcessed: stats.akashProcessed,
          akashErrors: stats.akashErrors,
          phalaProcessed: stats.phalaProcessed,
          phalaErrors: stats.phalaErrors,
          orgsPaused: stats.orgsPaused,
          totalDebitedCents: stats.totalDebitedCents,
          durationMs: duration,
        },
        'Cycle complete'
      )
    } catch (error) {
      log.error(error, 'Fatal error in billing cycle')
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

    log.info({ count: activeEscrows.length }, 'Processing active Akash escrows')

    for (const escrow of activeEscrows) {
      try {
        // Skip if deployment is no longer active
        if (escrow.akashDeployment.status !== 'ACTIVE') {
          log.info({ escrowId: escrow.id, status: escrow.akashDeployment.status }, 'Akash escrow deployment not active — skipping')
          continue
        }

        log.info(
          {
            escrowId: escrow.id,
            deploymentId: escrow.akashDeploymentId,
            dailyRateCents: escrow.dailyRateCents,
            consumedCents: escrow.consumedCents,
            depositCents: escrow.depositCents,
          },
          'Processing Akash escrow'
        )

        const updated = await escrowService.processDailyConsumption(escrow.id, this.forceMode)

        if (updated) {
          stats.akashProcessed++
          stats.totalDebitedCents += escrow.dailyRateCents
          log.info({ escrowId: escrow.id, consumedCents: escrow.dailyRateCents }, 'Akash escrow consumed daily rate')
        } else {
          log.info({ escrowId: escrow.id }, 'Akash escrow skipped (too soon since last billing or not active)')
        }
      } catch (error) {
        stats.akashErrors++
        log.error({ escrowId: escrow.id, err: error }, 'Akash escrow error')
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

    log.info({ count: activePhala.length }, 'Processing active Phala deployments')

    const now = new Date()

    for (const deployment of activePhala) {
      try {
        if (!deployment.orgBillingId || !deployment.hourlyRateCents) {
          log.info({ deploymentId: deployment.id }, 'Phala deployment missing orgBillingId or hourlyRateCents — skipping')
          continue
        }

        // Calculate billable hours since last billing
        const lastBilled = deployment.lastBilledAt || deployment.activeStartedAt || deployment.createdAt
        const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

        log.info(
          {
            deploymentId: deployment.id,
            lastBilled: lastBilled.toISOString(),
            hoursSince: Number(hoursSinceLastBill.toFixed(2)),
            hourlyRateCents: deployment.hourlyRateCents,
            orgBillingId: deployment.orgBillingId,
          },
          'Processing Phala deployment'
        )

        // Don't bill if less than 1 hour since last billing (skip in force mode)
        if (hoursSinceLastBill < 1 && !this.forceMode) {
          log.info({ deploymentId: deployment.id }, 'Phala deployment <1h since last bill — skipping')
          continue
        }

        // In force mode with <1 hour, bill for at least 1 hour
        const billableHours = this.forceMode ? Math.max(1, Math.floor(hoursSinceLastBill)) : Math.floor(hoursSinceLastBill)
        const amountCents = billableHours * deployment.hourlyRateCents

        if (amountCents <= 0) {
          log.info({ deploymentId: deployment.id }, 'Phala deployment amountCents=0 — skipping')
          continue
        }

        const dateKey = now.toISOString().slice(0, 10)
        const runId = this.forceMode ? `force_${Date.now()}` : dateKey
        const idempotencyKey = `phala_daily:${deployment.id}:${runId}`

        log.info(
          { deploymentId: deployment.id, billableHours, hourlyRateCents: deployment.hourlyRateCents, amountCents },
          'Billing Phala deployment'
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
          log.info({ deploymentId: deployment.id }, 'Phala deployment already processed (idempotency hit)')
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
          log.info({ deploymentId: deployment.id, debitedCents: amountCents }, 'Phala deployment debited')
        }
      } catch (error) {
        stats.phalaErrors++
        const errMsg = error instanceof Error ? error.message : String(error)

        // If insufficient balance, mark for pausing (handled in threshold check)
        if (errMsg.includes('INSUFFICIENT_BALANCE')) {
          log.warn({ deploymentId: deployment.id }, 'Phala deployment insufficient balance — will pause')
        } else {
          log.error(
            { deploymentId: deployment.id, err: error, body: (error as any).body },
            'Phala deployment error'
          )
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
          log.warn(
            { orgId, balanceCents: balanceInfo.balanceCents, dailyCostCents },
            'Org balance below 1-day burn — pausing deployments'
          )

          await this.pauseOrgDeployments(orgBillingId, orgId, balanceInfo.balanceCents, dailyCostCents)
          stats.orgsPaused++
        }
      } catch (error) {
        log.error({ orgBillingId, err: error }, 'Threshold check failed')
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
          log.warn({ dseq: deployment.dseq, err }, 'Failed to close Akash deployment on-chain')
        }

        // Pause escrow
        if (deployment.escrow) {
          await escrowService.pauseEscrow(deployment.id)
        }

        pausedServices.push(`Akash: dseq=${deployment.dseq}`)
      } catch (error) {
        log.error({ deploymentId: deployment.id, err: error }, 'Failed to pause Akash deployment')
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
        log.error({ deploymentId: deployment.id, err: error }, 'Failed to pause Phala deployment')
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
        log.error({ orgId, err: error }, 'Failed to send pause notification')
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
