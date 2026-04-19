/**
 * Internal endpoint: POST /internal/admin/gpu-probe-now
 *
 * Manual trigger for the GpuBidProbeScheduler. Mirrors the
 * verifier's `runNow()` pattern: useful for ops who want to refresh
 * pricing immediately after a chain outage, after a large new
 * provider comes online, or to validate behaviour before the next
 * scheduled cron tick.
 *
 * Auth: shared INTERNAL_AUTH_TOKEN via x-internal-auth header.
 *
 * Note: returns 202 Accepted immediately — the probe cycle takes
 * minutes, far longer than is reasonable for an HTTP request to hold
 * open. The structured log line at completion (and any opsAlert on
 * failure) is the primary signal.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../../lib/logger.js'
import type { GpuBidProbeScheduler } from './gpuBidProbeScheduler.js'

const log = createLogger('gpu-probe-manual-trigger')

export async function handleGpuProbeManualTrigger(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: GpuBidProbeScheduler
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  // Fire-and-forget. The scheduler's overlap lock is the source of
  // truth for "is one already running" — we just kick it.
  scheduler
    .runNow()
    .then(summary => {
      if (summary) {
        log.info(
          {
            runId: summary.runId,
            modelsProbed: summary.modelsProbed,
            totalBids: summary.totalBids,
            durationMs: summary.durationMs,
          },
          'Manual probe cycle complete'
        )
      } else {
        log.info('Manual probe cycle skipped (already running, low balance, or AKASH_MNEMONIC unset)')
      }
    })
    .catch(err => {
      log.error(
        { err: err instanceof Error ? err.message : err },
        'Manual probe cycle threw'
      )
    })

  res.writeHead(202, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      accepted: true,
      message: 'Probe cycle started in background. Watch logs for completion.',
    })
  )
}
