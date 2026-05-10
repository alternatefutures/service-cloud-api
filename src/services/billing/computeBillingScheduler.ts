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
  processFinalSpheronBilling,
  settleAkashEscrowToTime,
} from './deploymentSettlement.js'
import { reconcilePendingSettlements } from './settlementLedger.js'
import { reconcileAll as reconcileAllConcurrency } from '../concurrency/concurrencyService.js'
import { createLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { checkPolicyLimits } from '../policy/enforcer.js'
import { getAkashOrchestrator } from '../akash/orchestrator.js'
import { opsAlert } from '../../lib/opsAlert.js'
import { BLOCKS_PER_HOUR } from '../../config/akash.js'
import { randomUUID } from 'node:crypto'

const log = createLogger('compute-billing')

export class ComputeBillingScheduler {
  private cronJob: cron.ScheduledTask | null = null
  private thresholdCronJob: cron.ScheduledTask | null = null
  private running = false
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
    if (this.running) {
      log.warn('Skipping billing cycle — previous cycle still running')
      return
    }
    this.running = true

    const startTime = Date.now()
    // Shared trace id for every audit event produced by this tick. Makes it
    // trivial to fetch "everything that happened in cycle X" from the audit
    // log (Phase 44). Child processors (processAkashEscrows etc.) can adopt
    // it once D2 wires a scheduler-scoped AsyncLocalStorage.
    const tickTraceId = randomUUID()
    log.info({ tickTraceId }, 'Starting hourly billing cycle')

    const stats = {
      akashProcessed: 0,
      akashErrors: 0,
      akashIdempotencyHits: 0,
      phalaProcessed: 0,
      phalaErrors: 0,
      spheronProcessed: 0,
      spheronErrors: 0,
      spheronIdempotencyHits: 0,
      orgsPaused: 0,
      totalDebitedCents: 0,
    }

    try {
      // Drive escrow rows out of write-ahead states
      // BEFORE running the main billing loops. A row stuck in
      // PENDING_DEPOSIT is invisible to processAkashEscrows (which only
      // looks at ACTIVE), so without this the user could be charged on
      // auth's side but never billed/refunded on ours.
      try {
        const escrowRecon = await getEscrowService(this.prisma).reconcilePendingDeposits()
        if (escrowRecon.promoted > 0 || escrowRecon.failed > 0) {
          log.info(escrowRecon, 'Escrow write-ahead reconciler swept stuck rows')
        }
        const refundRecon = await getEscrowService(this.prisma).reconcilePendingRefunds()
        if (refundRecon.completed > 0 || refundRecon.failed > 0) {
          log.info(refundRecon, 'Escrow refund reconciler swept stuck rows')
        }
        const settlementRecon = await reconcilePendingSettlements(this.prisma)
        if (settlementRecon.committed > 0 || settlementRecon.failed > 0) {
          log.info(settlementRecon, 'Settlement-ledger reconciler swept stuck rows')
        }
        // Concurrency counter drift: any close path that forgot to
        // decrement leaves the org over-counted and unable to launch.
        // Recomputing from the deployment tables is cheap enough to do
        // every cycle and pins the worst-case lockout duration to the
        // billing interval.
        const concurrencyRecon = await reconcileAllConcurrency(this.prisma)
        if (concurrencyRecon.drifted > 0) {
          log.warn(concurrencyRecon, 'Concurrency counter reconciler corrected drift')
        }
      } catch (reconErr) {
        log.error(reconErr, 'Reconciler failed — continuing with billing cycle')
      }

      await this.processAkashEscrows(stats)
      await this.processPhalaDebits(stats)
      await this.processSpheronDebits(stats)

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
          akashIdempotencyHits: stats.akashIdempotencyHits,
          phalaProcessed: stats.phalaProcessed,
          phalaErrors: stats.phalaErrors,
          spheronProcessed: stats.spheronProcessed,
          spheronErrors: stats.spheronErrors,
          spheronIdempotencyHits: stats.spheronIdempotencyHits,
          orgsPaused: stats.orgsPaused,
          totalDebitedCents: stats.totalDebitedCents,
          policyBudgetStopped: policyStats.budgetStopped,
          policyRuntimeExpired: policyStats.runtimeExpired,
          durationMs: duration,
        },
        'Cycle complete'
      )

      // Phase 44 audit: one event per tick carrying the full stats blob.
      // status=warn when any provider errored but the cycle otherwise
      // completed; status=error lives in the catch block below.
      const hadErrors =
        stats.akashErrors > 0 || stats.phalaErrors > 0 || stats.spheronErrors > 0
      audit(this.prisma, {
        traceId: tickTraceId,
        source: 'cron',
        category: 'billing',
        action: 'billing.hourly_tick',
        status: hadErrors ? 'warn' : 'ok',
        durationMs: duration,
        payload: {
          ...stats,
          policyBudgetStopped: policyStats.budgetStopped,
          policyRuntimeExpired: policyStats.runtimeExpired,
          forceMode: this.forceMode,
          noPauseMode: this.noPauseMode,
        },
      })
    } catch (error) {
      log.error(error, 'Fatal error in billing cycle')
      audit(this.prisma, {
        traceId: tickTraceId,
        source: 'cron',
        category: 'billing',
        action: 'billing.hourly_tick',
        status: 'error',
        durationMs: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : String(error),
        payload: { ...stats, forceMode: this.forceMode, noPauseMode: this.noPauseMode },
      })
    } finally {
      this.running = false
    }
  }

  // ========================================
  // STEP 1: AKASH BILLING
  // ========================================

  private async processAkashEscrows(stats: {
    akashProcessed: number
    akashErrors: number
    akashIdempotencyHits: number
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

          // Advance lastBilledAt by exactly hoursToBill*1h (NOT to `now`).
          //
          // Why: the billing cron charges for integer hours via
          // Math.floor(hoursSinceLastBill). If we set lastBilledAt=now, the
          // fractional tail gets discarded forever. Example: deployment
          // created 23:08, first cron hits at 01:00 → hoursSinceLastBill=1.87,
          // hoursToBill=1. With `now`, the 0.87h from 23:08→00:08 is never
          // billed. With `lastBilled + hoursToBill*1h`, lastBilledAt becomes
          // 00:08 and that 0.87h rolls forward for the next cycle / final
          // settlement to pick up.
          //
          // Cap at `now` so forceMode (which bypasses the 1h minimum check)
          // cannot future-date lastBilledAt and silently skip the next cycle.
          //
          // Also mirror the auth-side charge into our DB even on idempotency
          // hits: `alreadyProcessed=true` means auth already debited this key
          // on a prior attempt; without the mirror the next cron cycle would
          // compute a larger hoursToBill with a FRESH key and double-charge.
          const advancedLastBilledAt = new Date(
            Math.min(now.getTime(), lastBilled.getTime() + hoursToBill * 3_600_000)
          )
          await this.prisma.deploymentEscrow.update({
            where: { id: escrow.id },
            data: {
              consumedCents: escrow.consumedCents + amountCents,
              lastBilledAt: advancedLastBilledAt,
            },
          })

          if (result.alreadyProcessed) {
            stats.akashIdempotencyHits = (stats.akashIdempotencyHits || 0) + 1
            log.info(
              { escrowId: escrow.id, amountCents, idempotencyKey },
              'Akash billing already processed (idempotency hit) — mirrored to local DB'
            )
            // Skip on-chain top-up on idempotency hits: we cannot tell whether
            // the prior attempt's top-up succeeded without extra chain queries,
            // and the :30 health monitor covers any shortfall safely.
          } else {
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
                const errMsg =
                  topUpErr instanceof Error ? topUpErr.message : String(topUpErr)
                log.warn(
                  {
                    dseq: String(escrow.akashDeployment.dseq),
                    hourlyUact,
                    err: errMsg,
                  },
                  'Post-billing escrow top-up failed — health monitor will catch up'
                )
                await opsAlert({
                  key: `billing-topup-failed:${escrow.akashDeploymentId}`,
                  severity: 'warning',
                  title: 'Billing-cycle top-up failed',
                  message:
                    `Hourly top-up for dseq=${escrow.akashDeployment.dseq} failed after a successful user charge. ` +
                    `The :30 escrow health monitor should recover, but repeated failures will drain on-chain escrow ` +
                    `and the provider will close the lease. Investigate wallet balance, RPC health, or dseq state.`,
                  context: {
                    deploymentId: escrow.akashDeploymentId,
                    dseq: String(escrow.akashDeployment.dseq),
                    hourlyUact: String(hourlyUact),
                    error: errMsg.slice(0, 400),
                  },
                  // Once per cycle is enough — no need to spam between runs.
                  suppressMs: 55 * 60 * 1000,
                })
              }
              // Sequence-settle delay is now held INSIDE withWalletLock
              // (see config/akash.ts TX_SETTLE_DELAY_MS). Do NOT add a
              // setTimeout here — it would be outside the mutex and would
              // not actually prevent the next caller from colliding on
              // the account sequence.
            }
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
          await opsAlert({
            key: `billing-cycle-escrow-error:${escrow.id}`,
            severity: 'warning',
            title: 'Akash billing cycle error',
            message:
              `Failed to bill escrow ${escrow.id} (deployment ${escrow.akashDeploymentId}) during the hourly cycle. ` +
              `If this persists across cycles the user will stop being charged for a live deployment.`,
            context: {
              escrowId: escrow.id,
              deploymentId: escrow.akashDeploymentId,
              dseq: String(escrow.akashDeployment.dseq ?? ''),
              orgBillingId: escrow.orgBillingId,
              error: errMsg.slice(0, 400),
            },
            suppressMs: 55 * 60 * 1000,
          })
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

    // Surface ACTIVE Phala deployments that the main loop
    // *cannot* bill because their orgBillingId is null. These are silent
    // money leaks (compute is running, no one is being charged) so we
    // page on every cycle until ops backfills the row.
    await this.alertUnbillablePhalaDeployments()

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

        const hoursToBill = this.forceMode
          ? Math.max(1, Math.floor(hoursSinceLastBill))
          : Math.max(1, Math.floor(hoursSinceLastBill))
        const amountCents = hoursToBill * deployment.hourlyRateCents

        if (amountCents <= 0) continue

        // Hourly idempotency key (was daily). With a daily key
        // the first hour-of-day bill would silently swallow EVERY subsequent
        // intra-day attempt as `alreadyProcessed`, dropping 23h of revenue
        // per active CVM. Hour-floor key matches the Akash pay-as-you-go
        // path above and lets us coalesce missed hours into one charge while
        // keeping the key bound to the slot the user is actually being
        // charged for.
        const slotStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
        const hourKey = slotStart.toISOString().slice(0, 13)
        const runId = this.forceMode ? `force_${hourKey}` : hourKey
        const idempotencyKey = `phala_hourly:${deployment.id}:${runId}`

        const result = await billingApi.computeDebit({
          orgBillingId: deployment.orgBillingId,
          amountCents,
          serviceType: 'phala_tee',
          provider: 'phala',
          resource: deployment.id,
          description: `Phala TEE ${deployment.cvmSize || 'tdx.large'}: ${hoursToBill}h @ $${(deployment.hourlyRateCents / 100).toFixed(2)}/hr`,
          idempotencyKey,
        })

        // Advance lastBilledAt by exactly hoursToBill*1h (NOT
        // to `now`), capped at `now`. Same fractional-tail rationale as
        // the Akash pay-as-you-go path above. ALSO mirror on idempotency
        // hits: without the mirror the next cycle would compute a larger
        // hoursToBill against a fresh hourly key and double-charge.
        const advancedLastBilledAt = new Date(
          Math.min(now.getTime(), lastBilled.getTime() + hoursToBill * 3_600_000)
        )
        await this.prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: {
            lastBilledAt: advancedLastBilledAt,
            totalBilledCents: deployment.totalBilledCents + amountCents,
          },
        })

        if (result.alreadyProcessed) {
          log.info(
            { deploymentId: deployment.id, amountCents, idempotencyKey },
            'Phala deployment already processed (idempotency hit) — mirrored to local DB'
          )
        } else {
          stats.phalaProcessed++
          stats.totalDebitedCents += amountCents
          log.info(
            { deploymentId: deployment.id, debitedCents: amountCents, hoursToBill },
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
          await opsAlert({
            key: `phala-billing-error:${deployment.id}`,
            severity: 'warning',
            title: 'Phala billing cycle error',
            message:
              `Failed to bill Phala deployment ${deployment.id} during the hourly cycle. ` +
              `If this persists the user will stop being charged for a live CVM.`,
            context: {
              deploymentId: deployment.id,
              orgBillingId: deployment.orgBillingId,
              hourlyRateCents: deployment.hourlyRateCents,
              error: errMsg.slice(0, 400),
            },
            suppressMs: 55 * 60 * 1000,
          })
        }
      }
    }

    // Reconciliation: any Phala deployment whose lastBilledAt
    // has drifted >2h behind `now` indicates a missed cycle (loop crashed,
    // pod crashed mid-run, etc). Surface so the next cycle's coalesce-bill
    // path picks them up; alert if the drift is severe.
    await this.detectPhalaBillingDrift()
  }

  /**
   * Emit an ops alert (and detailed log line) for any ACTIVE
   * Phala deployment that is missing `orgBillingId` or `hourlyRateCents`.
   * The main loop's `where` clause silently filters these out, so without
   * this they are invisible money leaks: compute is running on Phala but
   * nobody is being charged.
   */
  private async alertUnbillablePhalaDeployments(): Promise<void> {
    const broken = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { orgBillingId: null },
          { hourlyRateCents: null },
        ],
      },
      select: {
        id: true,
        appId: true,
        organizationId: true,
        orgBillingId: true,
        hourlyRateCents: true,
        createdAt: true,
      },
    })
    if (broken.length === 0) return

    log.error(
      { count: broken.length, ids: broken.map(b => b.id) },
      'ACTIVE Phala deployments missing billing fields — NOT being charged',
    )
    await opsAlert({
      key: 'phala-unbillable-deployments',
      severity: 'critical',
      title: 'ACTIVE Phala deployments are not being billed',
      message:
        `${broken.length} ACTIVE Phala deployment(s) have a NULL orgBillingId or hourlyRateCents. ` +
        `They are running on Phala but no one is paying for the compute. ` +
        `Backfill the missing fields ASAP — see admin/cloud/docs/AF_INCIDENT_RUNBOOKS.md.`,
      context: {
        count: broken.length,
        sample: broken.slice(0, 10).map(b => ({
          deploymentId: b.id,
          appId: b.appId,
          organizationId: b.organizationId,
          missing: [
            b.orgBillingId ? null : 'orgBillingId',
            b.hourlyRateCents ? null : 'hourlyRateCents',
          ].filter(Boolean),
        })),
      },
      suppressMs: 55 * 60 * 1000,
    })
  }

  /**
   * Find ACTIVE Phala deployments where `lastBilledAt` has
   * fallen behind `now` by more than the configured threshold. The next
   * billing cycle will coalesce-charge the missed hours via the regular
   * loop above (hoursToBill=floor(drift)), so reconciliation here is
   * primarily about visibility: surface drift early so we can investigate
   * before it becomes a multi-day backlog.
   */
  private async detectPhalaBillingDrift(): Promise<void> {
    const DRIFT_THRESHOLD_HOURS = 2
    const driftCutoff = new Date(Date.now() - DRIFT_THRESHOLD_HOURS * 3_600_000)
    const drifted = await this.prisma.phalaDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId: { not: null },
        hourlyRateCents: { not: null },
        OR: [
          { lastBilledAt: { lt: driftCutoff } },
          // No lastBilledAt yet but activeStartedAt > threshold: still
          // unbilled past the grace window.
          {
            lastBilledAt: null,
            activeStartedAt: { lt: driftCutoff },
          },
        ],
      },
      select: {
        id: true,
        appId: true,
        orgBillingId: true,
        lastBilledAt: true,
        activeStartedAt: true,
        hourlyRateCents: true,
      },
    })
    if (drifted.length === 0) return

    log.warn(
      {
        count: drifted.length,
        thresholdHours: DRIFT_THRESHOLD_HOURS,
        ids: drifted.map(d => d.id),
      },
      'Phala billing drift detected — next cycle will coalesce-charge missed hours',
    )
    await opsAlert({
      key: 'phala-billing-drift',
      severity: 'warning',
      title: 'Phala billing has drifted behind real time',
      message:
        `${drifted.length} ACTIVE Phala deployment(s) have lastBilledAt > ${DRIFT_THRESHOLD_HOURS}h behind now. ` +
        `The next cycle should coalesce the missed hours, but persistent drift means the cron isn't running ` +
        `cleanly — investigate scheduler health and pod logs.`,
      context: {
        count: drifted.length,
        thresholdHours: DRIFT_THRESHOLD_HOURS,
        sample: drifted.slice(0, 10).map(d => ({
          deploymentId: d.id,
          appId: d.appId,
          orgBillingId: d.orgBillingId,
          lastBilledAt: d.lastBilledAt?.toISOString() ?? null,
          activeStartedAt: d.activeStartedAt?.toISOString() ?? null,
          hourlyRateCents: d.hourlyRateCents,
        })),
      },
      suppressMs: 55 * 60 * 1000,
    })
  }

  // ========================================
  // STEP 2-bis: SPHERON PER-HOUR DEBITS
  // Mirrors processPhalaDebits exactly. Same liveness contract: the
  // provider-agnostic reconciler in staleDeploymentSweeper verifies ACTIVE
  // Spheron rows are still alive upstream; if a VM is dead, the reconciler
  // calls provider.close() which settles billing via
  // processFinalSpheronBilling(). This method trusts DB status.
  //
  // Two Spheron-specific notes:
  //   - 20-min minimum-runtime floor lives in processFinalSpheronBilling,
  //     NOT here. The hourly cadence (>= 1h elapsed) is always above the
  //     20-min floor so this loop never needs to consider it.
  //   - Resume after low-balance pause is a re-deploy from savedCloudInit
  //     (NO native start) — see resumeHandler.ts.
  // ========================================

  private async processSpheronDebits(stats: {
    spheronProcessed: number
    spheronErrors: number
    spheronIdempotencyHits: number
    totalDebitedCents: number
  }) {
    const billingApi = getBillingApiClient()

    const activeSpheron = await this.prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId: { not: null },
        hourlyRateCents: { not: null },
      },
    })

    log.info(
      { count: activeSpheron.length },
      'Processing active Spheron deployments'
    )

    // Surface ACTIVE Spheron deployments that the main loop *cannot* bill
    // because their orgBillingId / hourlyRateCents is null. Silent money
    // leak — page on every cycle until ops backfills the row. Mirror of
    // alertUnbillablePhalaDeployments.
    await this.alertUnbillableSpheronDeployments()

    const now = new Date()

    for (const deployment of activeSpheron) {
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

        if (
          hoursSinceLastBill < BILLING_CONFIG.spheron.billingIntervalHours &&
          !this.forceMode
        ) {
          log.info(
            { deploymentId: deployment.id },
            'Spheron deployment <1h since last bill — skipping'
          )
          continue
        }

        const hoursToBill = this.forceMode
          ? Math.max(1, Math.floor(hoursSinceLastBill))
          : Math.max(1, Math.floor(hoursSinceLastBill))
        const amountCents = hoursToBill * deployment.hourlyRateCents

        if (amountCents <= 0) continue

        // Hourly idempotency key (NEVER daily — see Phase 34 / Phala bug
        // PRP §3.6). Key is bound to the slot the user is being charged
        // for so coalesce-billing on missed cycles works.
        const slotStart = new Date(
          Math.floor(now.getTime() / 3_600_000) * 3_600_000
        )
        const hourKey = slotStart.toISOString().slice(0, 13)
        const runId = this.forceMode ? `force_${hourKey}` : hourKey
        const idempotencyKey = `spheron_hourly:${deployment.id}:${runId}`

        const result = await billingApi.computeDebit({
          orgBillingId: deployment.orgBillingId,
          amountCents,
          serviceType: 'spheron_vm',
          provider: 'spheron',
          resource: deployment.id,
          description:
            `Spheron VM (${deployment.gpuCount}× ${deployment.gpuType} @ ${deployment.provider}/${deployment.region}): ` +
            `${hoursToBill}h @ $${(deployment.hourlyRateCents / 100).toFixed(2)}/hr`,
          idempotencyKey,
          metadata: {
            deploymentId: deployment.id,
            providerDeploymentId: deployment.providerDeploymentId,
            upstreamProvider: deployment.provider,
            offerId: deployment.offerId,
            gpuType: deployment.gpuType,
            gpuCount: deployment.gpuCount,
            region: deployment.region,
            instanceType: deployment.instanceType,
            source: 'spheron_hourly_billing',
          },
        })

        // Phase 34 — mirror locally on every code path. Advance lastBilledAt
        // by exactly hoursToBill*1h (NOT to `now`), capped at `now`, so the
        // fractional tail rolls forward to the next cycle / final
        // settlement instead of being silently discarded. Update
        // totalBilledCents BEFORE the alreadyProcessed branch so a prior
        // `success` from auth that we never recorded locally cannot cause
        // the next cycle to compute hoursToBill against a stale anchor and
        // double-charge with a fresh idempotency key.
        const advancedLastBilledAt = new Date(
          Math.min(now.getTime(), lastBilled.getTime() + hoursToBill * 3_600_000)
        )
        await this.prisma.spheronDeployment.update({
          where: { id: deployment.id },
          data: {
            lastBilledAt: advancedLastBilledAt,
            totalBilledCents: deployment.totalBilledCents + amountCents,
          },
        })

        if (result.alreadyProcessed) {
          stats.spheronIdempotencyHits++
          log.info(
            { deploymentId: deployment.id, amountCents, idempotencyKey },
            'Spheron deployment already processed (idempotency hit) — mirrored to local DB'
          )
        } else {
          stats.spheronProcessed++
          stats.totalDebitedCents += amountCents
          log.info(
            { deploymentId: deployment.id, debitedCents: amountCents, hoursToBill },
            'Spheron deployment debited'
          )
        }
      } catch (error) {
        stats.spheronErrors++
        const errMsg = error instanceof Error ? error.message : String(error)

        if (errMsg.includes('INSUFFICIENT_BALANCE')) {
          log.warn(
            { deploymentId: deployment.id },
            'Spheron deployment insufficient balance — will pause'
          )
        } else {
          log.error(
            {
              deploymentId: deployment.id,
              err: error,
              body: (error as { body?: unknown }).body,
            },
            'Spheron deployment error'
          )
          await opsAlert({
            key: `spheron-billing-error:${deployment.id}`,
            severity: 'warning',
            title: 'Spheron billing cycle error',
            message:
              `Failed to bill Spheron deployment ${deployment.id} during the hourly cycle. ` +
              `If this persists the user will stop being charged for a live VM while the platform ` +
              `still owes Spheron the hourly rate.`,
            context: {
              deploymentId: deployment.id,
              providerDeploymentId: deployment.providerDeploymentId,
              orgBillingId: deployment.orgBillingId,
              hourlyRateCents: deployment.hourlyRateCents,
              upstreamProvider: deployment.provider,
              error: errMsg.slice(0, 400),
            },
            suppressMs: 55 * 60 * 1000,
          })
        }
      }
    }

    await this.detectSpheronBillingDrift()
  }

  /**
   * Emit an ops alert (and detailed log line) for any ACTIVE Spheron
   * deployment that is missing `orgBillingId` or `hourlyRateCents`. The
   * main loop's `where` clause silently filters these out, so without this
   * they are invisible money leaks: a VM is running on Spheron's network
   * (and Spheron is charging the platform) but no one is being billed.
   * Direct mirror of `alertUnbillablePhalaDeployments`.
   */
  private async alertUnbillableSpheronDeployments(): Promise<void> {
    const broken = await this.prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { orgBillingId: null },
          { hourlyRateCents: null },
        ],
      },
      select: {
        id: true,
        providerDeploymentId: true,
        organizationId: true,
        orgBillingId: true,
        hourlyRateCents: true,
        provider: true,
        gpuType: true,
        createdAt: true,
      },
    })
    if (broken.length === 0) return

    log.error(
      { count: broken.length, ids: broken.map(b => b.id) },
      'ACTIVE Spheron deployments missing billing fields — NOT being charged',
    )
    await opsAlert({
      key: 'spheron-unbillable-deployments',
      severity: 'critical',
      title: 'ACTIVE Spheron deployments are not being billed',
      message:
        `${broken.length} ACTIVE Spheron deployment(s) have a NULL orgBillingId or hourlyRateCents. ` +
        `They are running on Spheron (the platform is being charged) but no one is paying for the compute. ` +
        `Backfill the missing fields ASAP — see admin/cloud/docs/AF_INCIDENT_RUNBOOKS.md.`,
      context: {
        count: broken.length,
        sample: broken.slice(0, 10).map(b => ({
          deploymentId: b.id,
          providerDeploymentId: b.providerDeploymentId,
          organizationId: b.organizationId,
          upstreamProvider: b.provider,
          gpuType: b.gpuType,
          missing: [
            b.orgBillingId ? null : 'orgBillingId',
            b.hourlyRateCents ? null : 'hourlyRateCents',
          ].filter(Boolean),
        })),
      },
      suppressMs: 55 * 60 * 1000,
    })
  }

  /**
   * Find ACTIVE Spheron deployments whose `lastBilledAt` has fallen behind
   * `now` by more than the configured threshold. Same rationale as
   * `detectPhalaBillingDrift` — visibility for missed cycles. The next
   * cycle's coalesce-bill path picks them up (hoursToBill=floor(drift)).
   */
  private async detectSpheronBillingDrift(): Promise<void> {
    const DRIFT_THRESHOLD_HOURS = 2
    const driftCutoff = new Date(Date.now() - DRIFT_THRESHOLD_HOURS * 3_600_000)
    const drifted = await this.prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId: { not: null },
        hourlyRateCents: { not: null },
        OR: [
          { lastBilledAt: { lt: driftCutoff } },
          {
            lastBilledAt: null,
            activeStartedAt: { lt: driftCutoff },
          },
        ],
      },
      select: {
        id: true,
        providerDeploymentId: true,
        orgBillingId: true,
        lastBilledAt: true,
        activeStartedAt: true,
        hourlyRateCents: true,
      },
    })
    if (drifted.length === 0) return

    log.warn(
      {
        count: drifted.length,
        thresholdHours: DRIFT_THRESHOLD_HOURS,
        ids: drifted.map(d => d.id),
      },
      'Spheron billing drift detected — next cycle will coalesce-charge missed hours',
    )
    await opsAlert({
      key: 'spheron-billing-drift',
      severity: 'warning',
      title: 'Spheron billing has drifted behind real time',
      message:
        `${drifted.length} ACTIVE Spheron deployment(s) have lastBilledAt > ${DRIFT_THRESHOLD_HOURS}h behind now. ` +
        `The next cycle should coalesce the missed hours, but persistent drift means the cron isn't running ` +
        `cleanly — investigate scheduler health and pod logs.`,
      context: {
        count: drifted.length,
        thresholdHours: DRIFT_THRESHOLD_HOURS,
        sample: drifted.slice(0, 10).map(d => ({
          deploymentId: d.id,
          providerDeploymentId: d.providerDeploymentId,
          orgBillingId: d.orgBillingId,
          lastBilledAt: d.lastBilledAt?.toISOString() ?? null,
          activeStartedAt: d.activeStartedAt?.toISOString() ?? null,
          hourlyRateCents: d.hourlyRateCents,
        })),
      },
      suppressMs: 55 * 60 * 1000,
    })
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

    const activeSpheron = await this.prisma.spheronDeployment.findMany({
      where: { status: 'ACTIVE', orgBillingId: { not: null } },
      select: {
        orgBillingId: true,
        organizationId: true,
        hourlyRateCents: true,
        lastBilledAt: true,
        activeStartedAt: true,
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

    for (const s of activeSpheron) {
      if (!s.orgBillingId || !s.hourlyRateCents) continue
      const existing = orgBurnRates.get(s.orgBillingId) || {
        hourlyCostCents: 0,
        orgId: s.organizationId || '',
      }
      existing.hourlyCostCents += s.hourlyRateCents
      orgBurnRates.set(s.orgBillingId, existing)
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

    for (const s of activeSpheron) {
      if (!s.orgBillingId || !s.hourlyRateCents) continue
      // Anchor unbilled drift at activeStartedAt for parity with the
      // 20-min floor enforced in processFinalSpheronBilling — createdAt
      // would over-estimate when the row was queued before the upstream
      // POST landed.
      const anchor = s.lastBilledAt || s.activeStartedAt || s.createdAt || now
      const hoursSince = Math.max(
        0,
        (now.getTime() - new Date(anchor).getTime()) / (1000 * 60 * 60)
      )
      const unbilledCents = s.hourlyRateCents * hoursSince
      unbilledCostByOrg.set(
        s.orgBillingId,
        (unbilledCostByOrg.get(s.orgBillingId) || 0) + unbilledCents
      )
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

        // Suspension flow uses the structured close
        // result. CLOSED + ALREADY_CLOSED both transition the local
        // row to SUSPENDED (resumable). FAILED keeps the row ACTIVE
        // so the user keeps being billed and the next billing tick
        // retries — never silently move to SUSPENDED while the lease
        // is still live and draining escrow.
        const { getAkashOrchestrator } = await import('../akash/orchestrator.js')
        const orchestrator = getAkashOrchestrator(this.prisma)
        log.info({ dseq: deployment.dseq }, 'Closing on-chain deployment for suspension')
        const close = await orchestrator.closeDeployment(Number(deployment.dseq))
        const onChainClosed =
          close.chainStatus === 'CLOSED' || close.chainStatus === 'ALREADY_CLOSED'
        if (onChainClosed) {
          log.info(
            { dseq: deployment.dseq, chainStatus: close.chainStatus },
            'On-chain close completed for suspension',
          )
        } else {
          log.error(
            { dseq: deployment.dseq, error: close.error },
            'On-chain close FAILED — deployment stays ACTIVE and billed until next billing tick retries',
          )
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

          // SUSPENDED no longer counts toward the org's concurrency cap
          // (the lease is closed on chain). Reconciler would catch this
          // within the hour, but the user expects to be able to launch
          // a replacement immediately.
          if (result.count > 0 && deployment.escrow?.organizationId) {
            const { decrementOrgConcurrency } = await import(
              '../concurrency/concurrencyService.js'
            )
            await decrementOrgConcurrency(this.prisma, deployment.escrow.organizationId)
              .catch((err) => log.warn({ err, deploymentId: deployment.id }, 'Concurrency decrement failed (suspend Akash)'))
          }

          // Clear any reservation on the policy
          if (deployment.policyId) {
            await this.prisma.deploymentPolicy.updateMany({
              where: { id: deployment.policyId, reservedCents: { gt: 0 } },
              data: { reservedCents: 0, stopReason: 'BALANCE_LOW', stoppedAt },
            })
          }

          audit(this.prisma, {
            category: 'billing',
            action: 'balance.low_suspended',
            status: 'warn',
            orgId: deployment.escrow?.organizationId ?? undefined,
            deploymentId: deployment.id,
            payload: {
              provider: 'akash',
              dseq: deployment.dseq != null ? String(deployment.dseq) : null,
              hourlyCostCents: deploymentHourlyCost,
              balanceCentsAtSuspend: balanceCents,
              remainingHourlyBurnAfter: remainingHourlyBurn - deploymentHourlyCost,
            },
          })

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
            if (deployment.organizationId) {
              const { decrementOrgConcurrency } = await import(
                '../concurrency/concurrencyService.js'
              )
              await decrementOrgConcurrency(this.prisma, deployment.organizationId)
                .catch((err) => log.warn({ err, deploymentId: deployment.id }, 'Concurrency decrement failed (suspend Phala)'))
            }
            if (deployment.policyId) {
              await this.prisma.deploymentPolicy.updateMany({
                where: { id: deployment.policyId, reservedCents: { gt: 0 } },
                data: { reservedCents: 0, stopReason: 'BALANCE_LOW', stoppedAt },
              })
            }
            audit(this.prisma, {
              category: 'billing',
              action: 'balance.low_suspended',
              status: 'warn',
              deploymentId: deployment.id,
              payload: {
                provider: 'phala',
                appId: deployment.appId,
                hourlyCostCents: deploymentHourlyCost,
                balanceCentsAtSuspend: balanceCents,
                remainingHourlyBurnAfter: remainingHourlyBurn - deploymentHourlyCost,
              },
            })
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

    const spheronDeployments = await this.prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        orgBillingId,
      },
      include: {
        service: { select: { shutdownPriority: true, name: true } },
      },
    })

    spheronDeployments.sort((a, b) =>
      ((b as { service?: { shutdownPriority?: number } }).service
        ?.shutdownPriority ?? 50) -
      ((a as { service?: { shutdownPriority?: number } }).service
        ?.shutdownPriority ?? 50)
    )

    for (const deployment of spheronDeployments) {
      if (balanceCents >= remainingHourlyBurn * threshold) {
        log.info(
          { balanceCents, remainingHourlyBurn },
          'Remaining services affordable after Akash + Phala suspensions — skipping Spheron'
        )
        break
      }

      const deploymentHourlyCost = deployment.hourlyRateCents ?? 0

      try {
        const stoppedAt = new Date()

        // Phase 31 — settle billing BEFORE the upstream DELETE. This
        // applies the 20-min minimum-runtime floor for sub-20-min
        // deploys (see processFinalSpheronBilling).
        await processFinalSpheronBilling(
          this.prisma,
          deployment.id,
          stoppedAt,
          'spheron_balance_low_pause'
        )

        // Spheron has no native stop. Resume = re-deploy from
        // savedCloudInit / savedDeployInput (see resumeHandler.ts).
        // The provider adapter's close() handles the 20-min DELETE
        // floor by marking the row STOPPED locally and letting the
        // sweeper retry the upstream cleanup. Here we mirror the
        // Phala flow but use status=STOPPED (not DELETED) so resume
        // can find these rows. The sweeper's
        // reconcileSpheronUpstreamCleanups still cleans the upstream
        // VM eventually since providerDeploymentId stays populated
        // and upstreamDeletedAt is null.
        let providerStopped = false
        let upstreamDeletedAt: Date | null = null

        if (deployment.providerDeploymentId) {
          try {
            const { getSpheronOrchestrator } = await import('../spheron/orchestrator.js')
            const orchestrator = getSpheronOrchestrator(this.prisma)
            await orchestrator.closeDeployment(deployment.providerDeploymentId)
            upstreamDeletedAt = new Date()
            providerStopped = true
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            const { SpheronApiError } = await import('../spheron/client.js')
            if (err instanceof SpheronApiError && err.isAlreadyGone()) {
              log.warn(
                { providerDeploymentId: deployment.providerDeploymentId, err },
                'Spheron VM already gone during pause — treating as stopped'
              )
              upstreamDeletedAt = new Date()
              providerStopped = true
            } else if (
              err instanceof SpheronApiError &&
              err.isMinimumRuntimeNotMet()
            ) {
              // Defer upstream DELETE to the sweeper; row goes to
              // STOPPED (settled, hidden from user). The 20-min floor
              // billing was already charged in processFinalSpheronBilling.
              log.warn(
                { providerDeploymentId: deployment.providerDeploymentId },
                'Spheron DELETE deferred (minimum runtime) during pause — sweeper will retry'
              )
              providerStopped = true
            } else {
              log.error(
                { deploymentId: deployment.id, err: errMsg },
                'Spheron DELETE failed during pause — deployment stays ACTIVE and billed'
              )
            }
          }
        } else {
          // No upstream id — nothing to delete, treat as stopped.
          upstreamDeletedAt = new Date()
          providerStopped = true
        }

        if (providerStopped) {
          const result = await this.prisma.spheronDeployment.updateMany({
            where: { id: deployment.id, status: 'ACTIVE' },
            data: {
              status: 'STOPPED',
              ...(upstreamDeletedAt ? { upstreamDeletedAt } : {}),
            },
          })
          if (result.count > 0) {
            if (deployment.organizationId) {
              const { decrementOrgConcurrency } = await import(
                '../concurrency/concurrencyService.js'
              )
              await decrementOrgConcurrency(
                this.prisma,
                deployment.organizationId
              ).catch((err) =>
                log.warn(
                  { err, deploymentId: deployment.id },
                  'Concurrency decrement failed (suspend Spheron)'
                )
              )
            }
            if (deployment.policyId) {
              await this.prisma.deploymentPolicy.updateMany({
                where: { id: deployment.policyId, reservedCents: { gt: 0 } },
                data: { reservedCents: 0, stopReason: 'BALANCE_LOW', stoppedAt },
              })
            }
            audit(this.prisma, {
              category: 'billing',
              action: 'balance.low_suspended',
              status: 'warn',
              deploymentId: deployment.id,
              payload: {
                provider: 'spheron',
                providerDeploymentId: deployment.providerDeploymentId,
                hourlyCostCents: deploymentHourlyCost,
                balanceCentsAtSuspend: balanceCents,
                remainingHourlyBurnAfter:
                  remainingHourlyBurn - deploymentHourlyCost,
              },
            })
            remainingHourlyBurn -= deploymentHourlyCost
            pausedServices.push(
              `Spheron: ${deployment.name} (priority=${(deployment as { service?: { shutdownPriority?: number } }).service?.shutdownPriority ?? 50})`
            )
          }
        }
      } catch (error) {
        log.error(
          { deploymentId: deployment.id, err: error },
          'Failed to pause Spheron deployment'
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

    const spheronPolicies = await this.prisma.spheronDeployment.findMany({
      where: {
        status: 'ACTIVE',
        policyId: { not: null },
      },
      select: {
        policyId: true,
        totalBilledCents: true,
      },
    })

    for (const dep of spheronPolicies) {
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
