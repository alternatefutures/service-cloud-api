/**
 * Compute Billing Scheduler
 *
 * Hourly cron that processes:
 *   1. Akash deployments — direct wallet debit (pay-as-you-go) or escrow consumption (pre-funded)
 *      After each successful charge, tops up on-chain escrow for the next hour.
 *   2. Phala per-hour debits
 *   3. Balance threshold checks → pause if < 1 day burn
 *   4. Policy spend tracking and enforcement
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { getEscrowService } from './escrowService.js'
import { getBillingApiClient } from './billingApiClient.js'
import { BILLING_CONFIG } from '../../config/billing.js'
import {
  processFinalPhalaBilling,
  settleAkashEscrowToTime,
} from './deploymentSettlement.js'
import { createLogger } from '../../lib/logger.js'
import { checkPolicyLimits } from '../policy/enforcer.js'
import { getAkashOrchestrator } from '../akash/orchestrator.js'

const log = createLogger('compute-billing')

const BLOCKS_PER_HOUR = 600

export class ComputeBillingScheduler {
  private cronJob: cron.ScheduledTask | null = null
  private thresholdCronJob: cron.ScheduledTask | null = null
  private forceMode = false
  private noPauseMode = false
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    this.cronJob = cron.schedule(BILLING_CONFIG.scheduler.cronExpression, async () => {
      await this.runBillingCycle()
    })

    this.thresholdCronJob = cron.schedule(BILLING_CONFIG.thresholds.checkIntervalCron, async () => {
      await this.runThresholdCheck()
    })

    log.info(
      `Started — billing at ${BILLING_CONFIG.scheduler.cronExpression}, threshold checks at ${BILLING_CONFIG.thresholds.checkIntervalCron}`
    )
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
    }
    if (this.thresholdCronJob) {
      this.thresholdCronJob.stop()
      this.thresholdCronJob = null
    }
    log.info('Stopped')
  }

  async runThresholdCheck() {
    const startTime = Date.now()
    const stats = { orgsPaused: 0 }
    try {
      await this.checkThresholds(stats)
      const duration = Date.now() - startTime
      if (stats.orgsPaused > 0) {
        log.info({ orgsPaused: stats.orgsPaused, durationMs: duration }, 'Hourly threshold check — paused orgs')
      } else {
        log.debug({ durationMs: duration }, 'Hourly threshold check — all clear')
      }
    } catch (error) {
      log.error(error, 'Fatal error in hourly threshold check')
    }
  }

  async runNow(
    options: { force?: boolean; noPause?: boolean } | boolean = false
  ) {
    const opts =
      typeof options === 'boolean'
        ? { force: options, noPause: false }
        : options
    this.forceMode = opts.force ?? false
    this.noPauseMode = opts.noPause ?? false

    const flags = [
      opts.force ? 'FORCE' : null,
      opts.noPause ? 'NO-PAUSE' : null,
    ]
      .filter(Boolean)
      .join(', ')

    log.info(
      { flags: flags || undefined },
      'Manual trigger — running billing cycle now'
    )
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
    log.info('Starting hourly billing cycle')

    const stats = {
      akashProcessed: 0,
      akashErrors: 0,
      phalaProcessed: 0,
      phalaErrors: 0,
      orgsPaused: 0,
      totalDebitedCents: 0,
    }

    try {
      await this.processAkashEscrows(stats)
      await this.processPhalaDebits(stats)

      if (this.noPauseMode) {
        log.info('Skipping threshold/pause check (no-pause mode)')
      } else {
        await this.checkThresholds(stats)
      }

      await this.updatePolicySpend()
      const policyStats = await checkPolicyLimits(this.prisma)
      if (policyStats.budgetStopped > 0 || policyStats.runtimeExpired > 0) {
        log.info(
          {
            budgetStopped: policyStats.budgetStopped,
            runtimeExpired: policyStats.runtimeExpired,
          },
          'Policy enforcement triggered stops'
        )
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
          policyBudgetStopped: policyStats.budgetStopped,
          policyRuntimeExpired: policyStats.runtimeExpired,
          durationMs: duration,
        },
        'Cycle complete'
      )
    } catch (error) {
      log.error(error, 'Fatal error in billing cycle')
    }
  }

  // ========================================
  // STEP 1: AKASH BILLING
  // ========================================

  private async processAkashEscrows(stats: {
    akashProcessed: number
    akashErrors: number
    totalDebitedCents: number
  }) {
    const escrowService = getEscrowService(this.prisma)
    const billingApi = getBillingApiClient()

    const activeEscrows = await this.prisma.deploymentEscrow.findMany({
      where: { status: 'ACTIVE' },
      include: {
        akashDeployment: {
          select: {
            id: true,
            status: true,
            dseq: true,
            pricePerBlock: true,
            service: {
              select: {
                slug: true,
                name: true,
                templateId: true,
              },
            },
          },
        },
      },
    })

    log.info({ count: activeEscrows.length }, 'Processing active Akash escrows')

    for (const escrow of activeEscrows) {
      try {
        if (escrow.akashDeployment.status !== 'ACTIVE') {
          log.info(
            { escrowId: escrow.id, status: escrow.akashDeployment.status },
            'Akash escrow deployment not active — skipping'
          )
          continue
        }

        const now = new Date()
        const lastBilled = escrow.lastBilledAt || escrow.createdAt
        const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

        if (hoursSinceLastBill < BILLING_CONFIG.akash.minBillingIntervalHours && !this.forceMode) {
          log.info(
            { escrowId: escrow.id },
            'Akash escrow skipped (too soon since last billing)'
          )
          continue
        }

        log.info(
          {
            escrowId: escrow.id,
            deploymentId: escrow.akashDeploymentId,
            dailyRateCents: escrow.dailyRateCents,
            depositCents: escrow.depositCents,
            mode: escrow.depositCents > 0 ? 'pre-funded' : 'pay-as-you-go',
          },
          'Processing Akash escrow'
        )

        if (escrow.depositCents === 0) {
          // Pay-as-you-go: debit wallet directly (same pattern as Phala)
          const hoursToBill = this.forceMode
            ? Math.max(1, Math.floor(hoursSinceLastBill))
            : Math.max(1, Math.floor(hoursSinceLastBill))
          const hourlyRateCents = escrow.dailyRateCents / 24
          const amountCents = Math.round(hourlyRateCents * hoursToBill)

          if (amountCents <= 0) continue

          const hourKey = now.toISOString().slice(0, 13)
          const runId = this.forceMode ? `force_${hourKey}` : hourKey
          const idempotencyKey = `akash_hourly:${escrow.id}:${runId}`

          const result = await billingApi.computeDebit({
            orgBillingId: escrow.orgBillingId,
            amountCents,
            serviceType: 'akash_compute',
            provider: 'akash',
            resource: escrow.akashDeployment.service?.slug || escrow.akashDeploymentId,
            description: `Akash compute: ${hoursToBill}h @ $${(hourlyRateCents / 100).toFixed(2)}/hr`,
            idempotencyKey,
            metadata: {
              deploymentId: escrow.akashDeploymentId,
              dseq: escrow.akashDeployment.dseq?.toString(),
              source: 'akash_daily_billing',
            },
          })

          if (!result.alreadyProcessed) {
            await this.prisma.deploymentEscrow.update({
              where: { id: escrow.id },
              data: {
                consumedCents: escrow.consumedCents + amountCents,
                lastBilledAt: now,
              },
            })

            stats.akashProcessed++
            stats.totalDebitedCents += amountCents
            log.info(
              { escrowId: escrow.id, debitedCents: amountCents },
              'Akash pay-as-you-go billing complete'
            )

            // Top up on-chain escrow for the next hour so the lease stays alive.
            // Failures are non-fatal — the :30 health monitor will catch up.
            const ppb = parseInt(escrow.akashDeployment.pricePerBlock || '0', 10)
            if (ppb > 0 && escrow.akashDeployment.dseq) {
              const hourlyUact = ppb * BLOCKS_PER_HOUR
              try {
                const orchestrator = getAkashOrchestrator(this.prisma)
                await orchestrator.topUpDeploymentDeposit(
                  Number(escrow.akashDeployment.dseq), hourlyUact
                )
                log.info(
                  { dseq: String(escrow.akashDeployment.dseq), hourlyUact },
                  'Post-billing escrow top-up succeeded'
                )
              } catch (topUpErr) {
                log.warn(
                  {
                    dseq: String(escrow.akashDeployment.dseq),
                    hourlyUact,
                    err: topUpErr instanceof Error ? topUpErr.message : topUpErr,
                  },
                  'Post-billing escrow top-up failed — health monitor will catch up'
                )
              }
              await new Promise(r => setTimeout(r, 8000))
            }
          } else {
            log.info(
              { escrowId: escrow.id },
              'Akash billing already processed (idempotency hit)'
            )
          }
        } else {
          // Pre-funded mode: consume from escrow pool
          const updated = await escrowService.processDailyConsumption(
            escrow.id,
            this.forceMode
          )

          if (updated) {
            const consumedDelta = updated.consumedCents - escrow.consumedCents
            stats.akashProcessed++
            stats.totalDebitedCents += consumedDelta
            log.info(
              { escrowId: escrow.id, consumedCents: consumedDelta },
              'Akash pre-funded escrow consumed daily rate'
            )
          }
        }
      } catch (error) {
        stats.akashErrors++
        const errMsg = error instanceof Error ? error.message : String(error)

        if (errMsg.includes('INSUFFICIENT_BALANCE')) {
          log.warn(
            { escrowId: escrow.id },
            'Akash billing insufficient balance — will pause'
          )
        } else {
          log.error({ escrowId: escrow.id, err: error }, 'Akash escrow error')
        }
      }
    }
  }

  // ========================================
  // STEP 2: PHALA PER-HOUR DEBITS
  // Liveness of ACTIVE Phala deployments is verified by the provider-agnostic
  // reconciler in staleDeploymentSweeper — not inline here. If a CVM is dead,
  // the reconciler calls provider.close() which settles billing via
  // processFinalPhalaBilling(). This method trusts DB status.
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

    log.info(
      { count: activePhala.length },
      'Processing active Phala deployments'
    )

    const now = new Date()

    for (const deployment of activePhala) {
      try {
        if (!deployment.orgBillingId || !deployment.hourlyRateCents) {
          continue
        }

        const lastBilled =
          deployment.lastBilledAt ||
          deployment.activeStartedAt ||
          deployment.createdAt
        const hoursSinceLastBill =
          (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

        if (hoursSinceLastBill < BILLING_CONFIG.phala.billingIntervalHours && !this.forceMode) {
          log.info(
            { deploymentId: deployment.id },
            'Phala deployment <1h since last bill — skipping'
          )
          continue
        }

        const billableHours = this.forceMode
          ? Math.max(1, Math.floor(hoursSinceLastBill))
          : Math.floor(hoursSinceLastBill)
        const amountCents = billableHours * deployment.hourlyRateCents

        if (amountCents <= 0) continue

        const dateKey = now.toISOString().slice(0, 10)
        const runId = this.forceMode ? `force_${now.toISOString().slice(0, 13)}` : dateKey
        const idempotencyKey = `phala_daily:${deployment.id}:${runId}`

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
          log.info(
            { deploymentId: deployment.id },
            'Phala deployment already processed (idempotency hit)'
          )
        } else {
          await this.prisma.phalaDeployment.update({
            where: { id: deployment.id },
            data: {
              lastBilledAt: now,
              totalBilledCents: deployment.totalBilledCents + amountCents,
            },
          })

          stats.phalaProcessed++
          stats.totalDebitedCents += amountCents
          log.info(
            { deploymentId: deployment.id, debitedCents: amountCents },
            'Phala deployment debited'
          )
        }
      } catch (error) {
        stats.phalaErrors++
        const errMsg = error instanceof Error ? error.message : String(error)

        if (errMsg.includes('INSUFFICIENT_BALANCE')) {
          log.warn(
            { deploymentId: deployment.id },
            'Phala deployment insufficient balance — will pause'
          )
        } else {
          log.error(
            {
              deploymentId: deployment.id,
              err: error,
              body: (error as any).body,
            },
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

    const activeEscrows = await this.prisma.deploymentEscrow.findMany({
      where: {
        status: 'ACTIVE',
        akashDeployment: { status: 'ACTIVE' },
      },
      select: {
        orgBillingId: true,
        organizationId: true,
        dailyRateCents: true,
        lastBilledAt: true,
        createdAt: true,
      },
    })

    const activePhala = await this.prisma.phalaDeployment.findMany({
      where: { status: 'ACTIVE', orgBillingId: { not: null } },
      select: {
        orgBillingId: true,
        organizationId: true,
        hourlyRateCents: true,
        lastBilledAt: true,
        createdAt: true,
      },
    })

    const orgBurnRates = new Map<
      string,
      { hourlyCostCents: number; orgId: string }
    >()

    for (const e of activeEscrows) {
      const existing = orgBurnRates.get(e.orgBillingId) || {
        hourlyCostCents: 0,
        orgId: e.organizationId,
      }
      existing.hourlyCostCents += e.dailyRateCents / 24
      orgBurnRates.set(e.orgBillingId, existing)
    }

    for (const p of activePhala) {
      if (!p.orgBillingId || !p.hourlyRateCents) continue
      const existing = orgBurnRates.get(p.orgBillingId) || {
        hourlyCostCents: 0,
        orgId: p.organizationId || '',
      }
      existing.hourlyCostCents += p.hourlyRateCents
      orgBurnRates.set(p.orgBillingId, existing)
    }

    // Build a map of unbilled cost per orgBillingId by summing up cost accrued
    // since the last billing for each active deployment.
    const unbilledCostByOrg = new Map<string, number>()
    const now = new Date()

    for (const e of activeEscrows) {
      const lastBilled = e.lastBilledAt || e.createdAt || now
      const hoursSince = Math.max(0, (now.getTime() - new Date(lastBilled).getTime()) / (1000 * 60 * 60))
      const unbilledCents = (e.dailyRateCents / 24) * hoursSince
      unbilledCostByOrg.set(e.orgBillingId, (unbilledCostByOrg.get(e.orgBillingId) || 0) + unbilledCents)
    }

    for (const p of activePhala) {
      if (!p.orgBillingId || !p.hourlyRateCents) continue
      const lastBilled = p.lastBilledAt || p.createdAt || now
      const hoursSince = Math.max(0, (now.getTime() - new Date(lastBilled).getTime()) / (1000 * 60 * 60))
      const unbilledCents = p.hourlyRateCents * hoursSince
      unbilledCostByOrg.set(p.orgBillingId, (unbilledCostByOrg.get(p.orgBillingId) || 0) + unbilledCents)
    }

    for (const [orgBillingId, { hourlyCostCents, orgId }] of orgBurnRates) {
      try {
        const balanceInfo = await billingApi.getOrgBalance(orgBillingId)
        const unbilledCents = unbilledCostByOrg.get(orgBillingId) || 0
        const effectiveBalanceCents = balanceInfo.balanceCents - Math.ceil(unbilledCents)
        const thresholdCents = hourlyCostCents * BILLING_CONFIG.thresholds.lowBalanceHours

        if (effectiveBalanceCents < thresholdCents) {
          log.warn(
            {
              orgId,
              balanceCents: balanceInfo.balanceCents,
              unbilledCents: Math.ceil(unbilledCents),
              effectiveBalanceCents,
              hourlyCostCents,
              thresholdCents,
            },
            'Org effective balance below hourly threshold — suspending deployments'
          )

          await this.pauseOrgDeployments(
            orgBillingId,
            orgId,
            effectiveBalanceCents,
            hourlyCostCents * 24
          )
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

  private async pauseOrgDeployments(
    orgBillingId: string,
    orgId: string,
    balanceCents: number,
    dailyCostCents: number
  ) {
    const billingApi = getBillingApiClient()
    const escrowService = getEscrowService(this.prisma)
    const pausedServices: string[] = []

    const akashDeployments = await this.prisma.akashDeployment.findMany({
      where: {
        status: 'ACTIVE',
        escrow: { orgBillingId, status: 'ACTIVE' },
      },
      include: {
        escrow: true,
        service: { select: { shutdownPriority: true, name: true } },
      },
    })

    // Sort by shutdownPriority descending: highest number = sacrificed first
    akashDeployments.sort((a, b) =>
      (b.service?.shutdownPriority ?? 50) - (a.service?.shutdownPriority ?? 50)
    )

    // Track remaining hourly burn so we can stop suspending once affordable
    let remainingHourlyBurn = dailyCostCents / 24
    const threshold = BILLING_CONFIG.thresholds.lowBalanceHours

    for (const deployment of akashDeployments) {
      // If remaining services are now affordable, stop suspending
      if (balanceCents >= remainingHourlyBurn * threshold) {
        log.info(
          { balanceCents, remainingHourlyBurn, threshold },
          'Remaining services are affordable — stopping suspension'
        )
        break
      }

      const deploymentHourlyCost = deployment.escrow
        ? deployment.escrow.dailyRateCents / 24
        : 0

      try {
        const stoppedAt = new Date()

        await this.prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { savedSdl: deployment.sdlContent },
        })

        let onChainClosed = false
        try {
          const { getAkashOrchestrator } =
            await import('../akash/orchestrator.js')
          const orchestrator = getAkashOrchestrator(this.prisma)
          log.info({ dseq: deployment.dseq }, 'Closing on-chain deployment for suspension')
          await orchestrator.closeDeployment(Number(deployment.dseq))
          onChainClosed = true
          log.info({ dseq: deployment.dseq }, 'On-chain close TX submitted')
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
          }
        }

        if (onChainClosed) {
          const result = await this.prisma.akashDeployment.updateMany({
            where: { id: deployment.id, status: 'ACTIVE' },
            data: { status: 'SUSPENDED' },
          })

          if (result.count > 0 && deployment.escrow) {
            await settleAkashEscrowToTime(this.prisma, deployment.id, stoppedAt)
            await escrowService.pauseEscrow(deployment.id)
          }

          // Clear any reservation on the policy
          if (deployment.policyId) {
            await this.prisma.deploymentPolicy.updateMany({
              where: { id: deployment.policyId, reservedCents: { gt: 0 } },
              data: { reservedCents: 0, stopReason: 'BALANCE_LOW', stoppedAt },
            })
          }

          remainingHourlyBurn -= deploymentHourlyCost
        } else {
          log.error(
            { dseq: deployment.dseq },
            'Skipping SUSPENDED status — on-chain close did not succeed, lease still running'
          )
          continue
        }

        pausedServices.push(`Akash: dseq=${deployment.dseq} (priority=${deployment.service?.shutdownPriority ?? 50})`)
      } catch (error) {
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Akash deployment'
        )
      }
    }

    const phalaDeployments = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId,
      },
      include: {
        service: { select: { shutdownPriority: true, name: true } },
      },
    })

    // Sort Phala deployments by priority too
    phalaDeployments.sort((a, b) =>
      ((b as any).service?.shutdownPriority ?? 50) - ((a as any).service?.shutdownPriority ?? 50)
    )

    for (const deployment of phalaDeployments) {
      // If remaining services are now affordable, stop suspending
      if (balanceCents >= remainingHourlyBurn * threshold) {
        log.info(
          { balanceCents, remainingHourlyBurn },
          'Remaining services affordable after Akash suspensions — skipping Phala'
        )
        break
      }

      const deploymentHourlyCost = deployment.hourlyRateCents ?? 0

      try {
        const stoppedAt = new Date()
        await processFinalPhalaBilling(
          this.prisma,
          deployment.id,
          stoppedAt,
          'phala_balance_low_pause'
        )

        let providerStopped = false
        try {
          const { getPhalaOrchestrator } =
            await import('../phala/orchestrator.js')
          const orchestrator = getPhalaOrchestrator(this.prisma)
          await orchestrator.stopPhalaDeployment(deployment.appId)
          providerStopped = true
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const alreadyGone = /not found|does not exist|already stopped|already deleted|no such|404/i.test(errMsg)
          if (alreadyGone) {
            log.warn({ appId: deployment.appId, err }, 'CVM already gone during pause — treating as stopped')
            providerStopped = true
          } else {
            log.error({ deploymentId: deployment.id, err }, 'Phala stop failed — deployment stays ACTIVE')
          }
        }

        if (providerStopped) {
          const result = await this.prisma.phalaDeployment.updateMany({
            where: { id: deployment.id, status: 'ACTIVE' },
            data: { status: 'STOPPED' },
          })
          if (result.count > 0) {
            // Clear any reservation
            if (deployment.policyId) {
              await this.prisma.deploymentPolicy.updateMany({
                where: { id: deployment.policyId, reservedCents: { gt: 0 } },
                data: { reservedCents: 0, stopReason: 'BALANCE_LOW', stoppedAt },
              })
            }
            remainingHourlyBurn -= deploymentHourlyCost
            pausedServices.push(`Phala: ${deployment.name} (priority=${(deployment as any).service?.shutdownPriority ?? 50})`)
          }
        }
      } catch (error) {
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Phala deployment'
        )
      }
    }

    if (pausedServices.length > 0) {
      try {
        await billingApi.notify({
          orgId,
          type: 'low_balance_pause',
          email: '',
          balanceCents,
          dailyCostCents,
          pausedServices,
        })
      } catch (error) {
        log.error({ orgId, err: error }, 'Failed to send pause notification')
      }
    }
  }

  // ========================================
  // STEP 4: POLICY SPEND TRACKING
  // ========================================

  private async updatePolicySpend() {
    const akashPolicies = await this.prisma.akashDeployment.findMany({
      where: {
        status: 'ACTIVE',
        policyId: { not: null },
      },
      select: {
        policyId: true,
        escrow: { select: { consumedCents: true } },
        dailyRateCentsCharged: true,
      },
    })

    for (const dep of akashPolicies) {
      if (!dep.policyId) continue
      const spentUsd = dep.escrow
        ? dep.escrow.consumedCents / 100
        : dep.dailyRateCentsCharged
          ? dep.dailyRateCentsCharged / 100
          : 0
      if (spentUsd > 0) {
        await this.prisma.deploymentPolicy.update({
          where: { id: dep.policyId },
          data: { totalSpentUsd: spentUsd },
        })
      }
    }

    const phalaPolicies = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        policyId: { not: null },
      },
      select: {
        policyId: true,
        totalBilledCents: true,
      },
    })

    for (const dep of phalaPolicies) {
      if (!dep.policyId) continue
      const spentUsd = (dep.totalBilledCents ?? 0) / 100
      await this.prisma.deploymentPolicy.update({
        where: { id: dep.policyId },
        data: { totalSpentUsd: spentUsd },
      })
    }
  }
}

let instance: ComputeBillingScheduler | null = null

export function getComputeBillingScheduler(
  prisma: PrismaClient
): ComputeBillingScheduler {
  if (!instance) {
    instance = new ComputeBillingScheduler(prisma)
  }
  return instance
}
