/**
 * Stale run recovery.
 *
 * Both `verification_run` and `gpu_probe_run` are populated by a
 * "create row at start, update at end" pattern. If a process dies
 * between those two writes (OOM, SIGKILL during deploy, laptop sleep
 * during local dev, etc.) the row is stranded in `status='running'`
 * forever — and the admin dashboard then shows a misleading "Running"
 * badge for a job that's actually long-dead.
 *
 * The fix has two halves:
 *
 *   1. Wrap the row finalisation in `try/finally` (done in
 *      `providerVerification.ts` and `gpuBidProbe.ts`). This catches
 *      all in-process failures.
 *   2. On scheduler start-up, sweep any rows whose `started_at` is
 *      older than the maximum reasonable run duration and mark them
 *      `status='failed'` with an explanatory error. This catches
 *      out-of-process kills (the case the in-process try/finally
 *      cannot help with).
 *
 * `MAX_VERIFIER_RUN_MS` and `MAX_PROBE_RUN_MS` are deliberately set
 * well above the longest healthy run we've observed — false-positive
 * "stale" classifications would mark in-flight runs as failed and
 * spam the dashboard with red badges. The verifier's longest healthy
 * run was ~3.5h on Apr 9; we use 6h as the floor so even an unusually
 * slow GPU template doesn't get prematurely marked failed.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('stale-run-recovery')

/** 6h — comfortably above the longest healthy verifier run observed. */
export const MAX_VERIFIER_RUN_MS = 6 * 60 * 60 * 1000

/** 30m — a single probe is ~60s, all 15 GPU models with inter-probe
 *  delays should finish well inside 15 min. 30m is the "definitely
 *  dead" threshold. */
export const MAX_PROBE_RUN_MS = 30 * 60 * 1000

const STALE_ERROR_VERIFIER = 'Marked stale on scheduler startup — process likely died mid-run'
const STALE_ERROR_PROBE = 'Marked stale on scheduler startup — process likely died mid-run'

/**
 * Mark all `verification_run` rows still in `running` whose
 * `started_at` is older than `MAX_VERIFIER_RUN_MS` as `failed`.
 *
 * Returns the number of rows updated. Best-effort: a DB error here
 * must not stop the scheduler from starting.
 */
export async function markStaleVerifierRuns(prisma: PrismaClient): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - MAX_VERIFIER_RUN_MS)
    const result = await prisma.verificationRun.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        error: STALE_ERROR_VERIFIER,
      },
    })
    if (result.count > 0) {
      log.warn(
        { count: result.count, cutoff: cutoff.toISOString() },
        'Swept stale verifier runs at scheduler startup',
      )
    }
    return result.count
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'markStaleVerifierRuns failed — leaving rows as-is',
    )
    return 0
  }
}

/** Same as above, for `gpu_probe_run`. */
export async function markStaleProbeRuns(prisma: PrismaClient): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - MAX_PROBE_RUN_MS)
    const result = await prisma.gpuProbeRun.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        error: STALE_ERROR_PROBE,
      },
    })
    if (result.count > 0) {
      log.warn(
        { count: result.count, cutoff: cutoff.toISOString() },
        'Swept stale probe runs at scheduler startup',
      )
    }
    return result.count
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'markStaleProbeRuns failed — leaving rows as-is',
    )
    return 0
  }
}
