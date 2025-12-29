/**
 * Telemetry Ingestion Service
 *
 * Handles ingestion tracking for APM billing.
 * Receives events from OTEL Collector and buffers them for billing aggregation.
 *
 * Similar pattern to UsageBuffer - uses PostgreSQL for reliable persistence.
 */

import { setInterval, clearInterval } from 'node:timers'
import type { PrismaClient } from '@prisma/client'

export interface IngestionEvent {
  projectId: string
  projectSlug?: string
  spansCount?: number
  metricsCount?: number
  logsCount?: number
  bytesEstimate?: number
  timestamp?: Date
}

export interface TelemetryIngestionBuffer {
  projectId: string
  spansCount: number
  metricsCount: number
  logsCount: number
  bytesIngested: bigint
  periodStart: Date
  periodEnd: Date
}

export class TelemetryIngestionService {
  private prisma: PrismaClient
  private flushInterval: NodeJS.Timeout | null = null
  private buffer: Map<string, TelemetryIngestionBuffer> = new Map()
  private readonly flushIntervalMs = 60 * 1000 // 1 minute

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
    console.log('[TelemetryIngestion] Service initialized')
  }

  /**
   * Start the periodic flush timer
   */
  start(): void {
    if (this.flushInterval) {
      return
    }

    this.flushInterval = setInterval(async () => {
      try {
        await this.flush()
      } catch (error) {
        console.error('[TelemetryIngestion] Flush error:', error)
      }
    }, this.flushIntervalMs)

    console.log('[TelemetryIngestion] Started with 1-minute flush interval')
  }

  /**
   * Stop the periodic flush timer
   */
  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }

    // Final flush before shutdown
    await this.flush()
    console.log('[TelemetryIngestion] Stopped and flushed remaining data')
  }

  /**
   * Record an ingestion event from OTEL Collector
   * Buffers in memory and flushes periodically to database
   */
  recordIngestion(event: IngestionEvent): void {
    const {
      projectId,
      spansCount = 0,
      metricsCount = 0,
      logsCount = 0,
      bytesEstimate = 0,
    } = event
    const now = new Date()

    // Get or create buffer entry for this project
    let entry = this.buffer.get(projectId)

    if (!entry) {
      const hourStart = new Date(now)
      hourStart.setMinutes(0, 0, 0)

      const hourEnd = new Date(hourStart)
      hourEnd.setHours(hourEnd.getHours() + 1)

      entry = {
        projectId,
        spansCount: 0,
        metricsCount: 0,
        logsCount: 0,
        bytesIngested: BigInt(0),
        periodStart: hourStart,
        periodEnd: hourEnd,
      }
      this.buffer.set(projectId, entry)
    }

    // Check if we've moved to a new hour - flush old data if so
    const currentHour = new Date(now)
    currentHour.setMinutes(0, 0, 0)

    if (currentHour > entry.periodStart) {
      // We've moved to a new hour, flush the old entry
      this.flushEntry(entry).catch(err => {
        console.error(
          '[TelemetryIngestion] Failed to flush on hour rollover:',
          err
        )
      })

      const hourEnd = new Date(currentHour)
      hourEnd.setHours(hourEnd.getHours() + 1)

      entry = {
        projectId,
        spansCount: 0,
        metricsCount: 0,
        logsCount: 0,
        bytesIngested: BigInt(0),
        periodStart: currentHour,
        periodEnd: hourEnd,
      }
      this.buffer.set(projectId, entry)
    }

    // Increment counters
    entry.spansCount += spansCount
    entry.metricsCount += metricsCount
    entry.logsCount += logsCount
    entry.bytesIngested += BigInt(bytesEstimate)
  }

  /**
   * Flush a single buffer entry to database
   */
  private async flushEntry(entry: TelemetryIngestionBuffer): Promise<void> {
    if (
      entry.spansCount === 0 &&
      entry.metricsCount === 0 &&
      entry.logsCount === 0
    ) {
      return // Nothing to flush
    }

    try {
      // Upsert: update if exists, create if not
      await this.prisma.telemetryIngestion.upsert({
        where: {
          projectId_periodStart_periodEnd: {
            projectId: entry.projectId,
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
          },
        },
        create: {
          projectId: entry.projectId,
          bytesIngested: entry.bytesIngested,
          spansCount: entry.spansCount,
          metricsCount: entry.metricsCount,
          logsCount: entry.logsCount,
          periodStart: entry.periodStart,
          periodEnd: entry.periodEnd,
        },
        update: {
          bytesIngested: {
            increment: entry.bytesIngested,
          },
          spansCount: {
            increment: entry.spansCount,
          },
          metricsCount: {
            increment: entry.metricsCount,
          },
          logsCount: {
            increment: entry.logsCount,
          },
        },
      })

      console.log(
        `[TelemetryIngestion] Flushed project ${entry.projectId}: ` +
          `spans=${entry.spansCount}, metrics=${entry.metricsCount}, ` +
          `logs=${entry.logsCount}, bytes=${entry.bytesIngested}`
      )
    } catch (error) {
      console.error(
        `[TelemetryIngestion] Failed to flush project ${entry.projectId}:`,
        error
      )
      throw error
    }
  }

  /**
   * Flush all buffered data to database
   */
  async flush(): Promise<void> {
    const entries = Array.from(this.buffer.values())

    if (entries.length === 0) {
      return
    }

    console.log(
      `[TelemetryIngestion] Flushing ${entries.length} project buffers`
    )

    const errors: Error[] = []

    for (const entry of entries) {
      try {
        await this.flushEntry(entry)

        // Reset the entry counters after successful flush
        entry.spansCount = 0
        entry.metricsCount = 0
        entry.logsCount = 0
        entry.bytesIngested = BigInt(0)
      } catch (error) {
        errors.push(error as Error)
      }
    }

    if (errors.length > 0) {
      console.error(
        `[TelemetryIngestion] ${errors.length} flush errors occurred`
      )
    }
  }

  /**
   * Get current buffer statistics (for monitoring)
   */
  getStats(): {
    projectsBuffered: number
    totalSpans: number
    totalMetrics: number
    totalLogs: number
    totalBytes: bigint
  } {
    let totalSpans = 0
    let totalMetrics = 0
    let totalLogs = 0
    let totalBytes = BigInt(0)

    for (const entry of this.buffer.values()) {
      totalSpans += entry.spansCount
      totalMetrics += entry.metricsCount
      totalLogs += entry.logsCount
      totalBytes += entry.bytesIngested
    }

    return {
      projectsBuffered: this.buffer.size,
      totalSpans,
      totalMetrics,
      totalLogs,
      totalBytes,
    }
  }

  /**
   * Get ingestion usage for a project within a date range
   */
  async getProjectUsage(
    projectId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    bytesIngested: bigint
    spansCount: number
    metricsCount: number
    logsCount: number
  }> {
    const ingestions = await this.prisma.telemetryIngestion.findMany({
      where: {
        projectId,
        periodStart: {
          gte: startDate,
        },
        periodEnd: {
          lte: endDate,
        },
      },
    })

    let bytesIngested = BigInt(0)
    let spansCount = 0
    let metricsCount = 0
    let logsCount = 0

    for (const record of ingestions) {
      bytesIngested += record.bytesIngested
      spansCount += record.spansCount
      metricsCount += record.metricsCount
      logsCount += record.logsCount
    }

    return {
      bytesIngested,
      spansCount,
      metricsCount,
      logsCount,
    }
  }

  /**
   * Calculate billing cost for telemetry usage
   */
  async calculateCost(
    projectId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    bytesIngested: bigint
    bytesFormatted: string
    costCents: number
    costFormatted: string
  }> {
    const usage = await this.getProjectUsage(projectId, startDate, endDate)

    // Get billing settings
    const settings = await this.prisma.billingSettings.findFirst()
    const perGBCents = settings?.telemetryPerGBCents ?? 35 // Default $0.35/GB

    // Calculate cost
    const bytesAsNumber = Number(usage.bytesIngested)
    const gbIngested = bytesAsNumber / (1024 * 1024 * 1024)
    const costCents = Math.ceil(gbIngested * perGBCents)

    // Format for display
    const bytesFormatted = this.formatBytes(bytesAsNumber)
    const costFormatted = `$${(costCents / 100).toFixed(2)}`

    return {
      bytesIngested: usage.bytesIngested,
      bytesFormatted,
      costCents,
      costFormatted,
    }
  }

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
}

// Singleton instance
let instance: TelemetryIngestionService | null = null

export function getTelemetryIngestionService(
  prisma: PrismaClient
): TelemetryIngestionService {
  if (!instance) {
    instance = new TelemetryIngestionService(prisma)
  }
  return instance
}
