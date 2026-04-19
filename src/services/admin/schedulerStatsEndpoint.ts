/**
 * Internal endpoint: GET /internal/admin/scheduler-stats
 *
 * Aggregate health/cost telemetry for the two long-running cron jobs
 * that touch the wallet — ProviderVerificationScheduler and
 * GpuBidProbeScheduler. This is what the admin dashboard's third
 * provider-strip card consumes.
 *
 * Numbers come from three places:
 *   1. `verification_run` (one row per verifier cycle)
 *   2. `gpu_probe_run`    (one row per probe cycle)
 *   3. live counts from `compute_provider` and `gpu_price_summary`
 *
 * `cost_uact` on each run is captured as the wallet balance delta around
 * the cycle, so totals here reflect *actual* on-chain spend (gas +
 * unrefunded deposits), not estimates.
 *
 * Secured by INTERNAL_AUTH_TOKEN — same pattern as billing-stats.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('admin-scheduler-stats')

/**
 * 1 ACT (the AKT compute credit) is denominated in 1_000_000 uact —
 * same convention used everywhere in the wallet/balance code.
 */
const UACT_PER_ACT = 1_000_000

/** Aggregate row coming back from the SQL summary. */
interface RunAggregateRow {
  total_runs: bigint
  successful_runs: bigint
  failed_runs: bigint
  total_cost_uact: bigint
}

interface SchedulerStatsResponse {
  verifier: {
    /** Total `verification_run` rows ever recorded. */
    totalRuns: number
    successfulRuns: number
    failedRuns: number
    /** Lifetime sum of cost_uact, expressed in ACT (USD-pegged). */
    totalCostAct: number
    /** Most recent run, or null if none yet. */
    lastRun: {
      startedAt: string
      completedAt: string | null
      status: string
      passed: number
      failed: number
      uniqueProviders: number
      costAct: number
    } | null
    /** Live count of currently-verified providers. */
    verifiedProviderCount: number
  }
  probe: {
    totalRuns: number
    successfulRuns: number
    failedRuns: number
    totalCostAct: number
    lastRun: {
      startedAt: string
      completedAt: string | null
      status: string
      modelsProbed: number
      bidsCollected: number
      uniqueProviders: number
      costAct: number
    } | null
    /** Live count of distinct GPU models in `gpu_price_summary`. */
    gpuModelsTracked: number
    /** Most recent `refreshed_at` across `gpu_price_summary`, or null. */
    lastPriceRefresh: string | null
  }
}

/** uact (BigInt) → ACT (number) with 4 decimals — enough resolution
 *  for the dashboard ($0.0001 per unit), avoids fp drift on display. */
function uactToAct(uact: bigint): number {
  // Use string-then-parse to preserve precision for very large totals
  // without importing a decimal lib for one division.
  const whole = uact / BigInt(UACT_PER_ACT)
  const remainder = uact % BigInt(UACT_PER_ACT)
  return Number(whole) + Number(remainder) / UACT_PER_ACT
}

export async function handleSchedulerStats(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient,
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const [
      verifierAgg,
      lastVerifier,
      verifiedProviderCount,
      probeAgg,
      lastProbe,
      gpuModelsTracked,
      lastPriceRefreshRow,
    ] = await Promise.all([
      prisma.$queryRaw<RunAggregateRow[]>`
        SELECT
          COUNT(*)::bigint                                                AS total_runs,
          COUNT(*) FILTER (WHERE status = 'completed')::bigint           AS successful_runs,
          COUNT(*) FILTER (WHERE status = 'failed')::bigint              AS failed_runs,
          COALESCE(SUM(cost_uact), 0)::bigint                            AS total_cost_uact
        FROM "verification_run"
      `,
      prisma.verificationRun.findFirst({
        orderBy: { startedAt: 'desc' },
      }),
      prisma.computeProvider.count({
        where: { verified: true, blocked: false },
      }),
      prisma.$queryRaw<RunAggregateRow[]>`
        SELECT
          COUNT(*)::bigint                                                AS total_runs,
          COUNT(*) FILTER (WHERE status = 'completed')::bigint           AS successful_runs,
          COUNT(*) FILTER (WHERE status = 'failed')::bigint              AS failed_runs,
          COALESCE(SUM(cost_uact), 0)::bigint                            AS total_cost_uact
        FROM "gpu_probe_run"
      `,
      prisma.gpuProbeRun.findFirst({
        orderBy: { startedAt: 'desc' },
      }),
      prisma.gpuPriceSummary.count(),
      prisma.gpuPriceSummary.findFirst({
        orderBy: { refreshedAt: 'desc' },
        select: { refreshedAt: true },
      }),
    ])

    const v = verifierAgg[0]
    const p = probeAgg[0]

    const body: SchedulerStatsResponse = {
      verifier: {
        totalRuns: Number(v.total_runs),
        successfulRuns: Number(v.successful_runs),
        failedRuns: Number(v.failed_runs),
        totalCostAct: uactToAct(v.total_cost_uact),
        lastRun: lastVerifier
          ? {
              startedAt: lastVerifier.startedAt.toISOString(),
              completedAt: lastVerifier.completedAt?.toISOString() ?? null,
              status: lastVerifier.status,
              passed: lastVerifier.passed,
              failed: lastVerifier.failed,
              uniqueProviders: lastVerifier.uniqueProviders,
              costAct: uactToAct(lastVerifier.costUact),
            }
          : null,
        verifiedProviderCount,
      },
      probe: {
        totalRuns: Number(p.total_runs),
        successfulRuns: Number(p.successful_runs),
        failedRuns: Number(p.failed_runs),
        totalCostAct: uactToAct(p.total_cost_uact),
        lastRun: lastProbe
          ? {
              startedAt: lastProbe.startedAt.toISOString(),
              completedAt: lastProbe.completedAt?.toISOString() ?? null,
              status: lastProbe.status,
              modelsProbed: lastProbe.modelsProbed,
              bidsCollected: lastProbe.bidsCollected,
              uniqueProviders: lastProbe.uniqueProviders,
              costAct: uactToAct(lastProbe.costUact),
            }
          : null,
        gpuModelsTracked,
        lastPriceRefresh: lastPriceRefreshRow?.refreshedAt.toISOString() ?? null,
      },
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'Failed to fetch scheduler stats',
    )
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
