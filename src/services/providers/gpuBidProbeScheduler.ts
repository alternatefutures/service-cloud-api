/**
 * GPU Bid Probe Scheduler
 *
 * Every 6h, posts a tiny probe deployment per GPU model the registry
 * knows about, captures the bids that come back, then rolls them up
 * into `gpu_price_summary`. The web-app reads `gpu_price_summary` via
 * the internal pricing endpoint and renders per-GPU min/p50/p90/max
 * instead of the broken per-provider min/max attribution it used to
 * show.
 *
 * Cadence rationale:
 *   - 6h × 4 runs/day × ~15 models × ~$0.0015/probe ≈ $0.09/day. Cheap.
 *   - GPU bid prices don't move in minutes — providers re-price at most
 *     every few hours, often daily. 6h captures real movement without
 *     paying for sub-hourly noise.
 *   - 04:00 UTC is owned by ProviderVerificationScheduler (Mon/Wed/Fri).
 *     We use the offset slots `01:00, 07:00, 13:00, 19:00` so the wallet
 *     mutex never has to choose between us and the verifier.
 *
 * Guards:
 *   - Overlap: skip if a previous run is still in progress
 *   - Balance: skip if uact < MIN_ACT_BALANCE_UACT (verification scheduler
 *     uses the same 5_000_000 floor)
 *   - Environment: skip if AKASH_MNEMONIC is not set (non-Akash deploys)
 *
 * Wrapped in `runWithLeadership('gpu-bid-probe-scheduler', …)` in
 * `index.ts` so multi-replica deploys only probe from one pod.
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { opsAlert } from '../../lib/opsAlert.js'
import { runGpuBidProbeCycle, type ProbeCycleSummary } from './gpuBidProbe.js'
import { checkBalance } from './providerVerification.js'

const log = createLogger('gpu-bid-probe-scheduler')

const MIN_ACT_BALANCE_UACT = 5_000_000

export class GpuBidProbeScheduler {
  private cronJob: cron.ScheduledTask | null = null
  private running = false
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }
    if (!process.env.AKASH_MNEMONIC) {
      log.warn('AKASH_MNEMONIC not set — gpu bid probe scheduler disabled')
      return
    }

    // 01:00, 07:00, 13:00, 19:00 UTC — staggered off the verifier's 04:00 slot.
    this.cronJob = cron.schedule('0 1,7,13,19 * * *', () => {
      this.runProbe().catch(err => {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'Scheduled gpu probe failed'
        )
      })
    })

    log.info('Started — runs at 01:00, 07:00, 13:00, 19:00 UTC')
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /** Trigger a probe cycle manually (e.g. from /internal/admin/gpu-probe-now). */
  async runNow(): Promise<ProbeCycleSummary | null> {
    return this.runProbe()
  }

  private async runProbe(): Promise<ProbeCycleSummary | null> {
    if (this.running) {
      log.warn('Skipping — previous probe cycle still in progress')
      return null
    }
    this.running = true
    const start = Date.now()

    try {
      // Pre-flight balance check — same MIN as verifier so a single
      // wallet drainage event grounds both schedulers in lockstep.
      const balance = await checkBalance()
      if (balance.uact < MIN_ACT_BALANCE_UACT) {
        log.warn(
          { uact: balance.uact, minimum: MIN_ACT_BALANCE_UACT },
          'Insufficient ACT balance — skipping gpu probe cycle'
        )
        await opsAlert({
          key: 'gpu-probe-low-balance',
          severity: 'warning',
          title: 'GPU bid probe skipped (low balance)',
          message: `Wallet ACT balance ${balance.act} below minimum ${MIN_ACT_BALANCE_UACT / 1_000_000}.`,
          context: { uact: balance.uact, minUact: MIN_ACT_BALANCE_UACT },
        })
        return null
      }

      const summary = await runGpuBidProbeCycle(this.prisma)

      log.info(
        {
          runId: summary.runId,
          modelsProbed: summary.modelsProbed,
          totalBids: summary.totalBids,
          uniqueProviders: summary.uniqueProviders,
          durationMs: summary.durationMs,
        },
        'GPU probe cycle complete'
      )

      // Zero bids across every model is almost certainly a chain or
      // wallet outage, not a real shortage of GPUs. Page ops.
      if (summary.modelsProbed > 0 && summary.totalBids === 0) {
        await opsAlert({
          key: 'gpu-probe-zero-bids',
          severity: 'warning',
          title: 'GPU bid probe cycle returned zero bids',
          message:
            'All GPU model probes returned zero bids — likely a chain RPC, wallet, or provider-side outage.',
          context: { runId: summary.runId, modelsProbed: summary.modelsProbed },
        })
      }

      return summary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'Probe cycle threw')
      await opsAlert({
        key: 'gpu-probe-failed',
        severity: 'warning',
        title: 'GPU bid probe cycle failed',
        message: msg.slice(0, 400),
      })
      return null
    } finally {
      this.running = false
      log.info({ durationMs: Date.now() - start }, 'Probe cycle finished')
    }
  }
}
