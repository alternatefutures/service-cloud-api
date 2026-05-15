/**
 * Audit Export Scheduler
 *
 * Runs the daily JSONL export at 00:30 UTC. The 30-minute offset
 * after midnight intentionally lets the billing tick (00:00 UTC)
 * complete first — we want its `billing.hourly_tick` events to
 * land in the previous day's file when the tick straddles the
 * day boundary, AND we want to avoid contending with the billing
 * scheduler for db connections.
 *
 * If the export fails, the scheduler logs and exits — it does NOT
 * retry inside the same tick. Re-running is cheap (`pnpm tsx
 * scripts/export-audit-day.ts <date>`) and the partial file is
 * discarded by atomic-rename in the writer, so a failure leaves
 * no half-written artifact behind.
 */

import * as cron from 'node-cron'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { requestContext } from '../../lib/requestContext.js'
import { exportAuditDay } from './auditExporter.js'

const log = createLogger('audit-export-scheduler')

export class AuditExportScheduler {
  private cronJob: cron.ScheduledTask | null = null

  constructor(private prisma: PrismaClient) {}

  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    // 00:30 UTC every day. UTC matters: AUDIT_EXPORT_DIR layout is
    // YYYY/MM/YYYY-MM-DD.jsonl with day boundaries fixed in UTC, so
    // the cron must fire on the same clock.
    this.cronJob = cron.schedule(
      '30 0 * * *',
      async () => {
        await this.runForYesterday()
      },
      { timezone: 'UTC' },
    )

    log.info('Started — runs daily at 00:30 UTC')
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /**
   * Run the export for "yesterday" in UTC. Wrapped in a fresh
   * requestContext so any audit() the exporter itself emits (failure
   * path, future enrichment) shares one trace id within this run.
   */
  async runForYesterday() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const traceId = randomUUID()
    await requestContext.run({ requestId: traceId, traceId }, async () => {
      try {
        const result = await exportAuditDay(this.prisma, yesterday)
        log.info(result, 'Daily audit export ok')
      } catch (err) {
        log.error({ err }, 'Daily audit export FAILED — re-run with scripts/export-audit-day.ts <YYYY-MM-DD>')
      }
    })
  }
}
