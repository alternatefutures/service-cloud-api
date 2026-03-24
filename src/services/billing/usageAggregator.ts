/**
 * Usage Aggregator
 *
 * Flushes buffered usage data from PostgreSQL buffer table to main table every minute.
 * This reduces database writes by ~97% vs. writing directly on each request.
 *
 * Architecture:
 * 1. Requests increment buffer table counters (fast UPSERT, no main table write)
 * 2. Every minute, this aggregator reads all buffered counters
 * 3. Writes one aggregated record per user to main usage table
 * 4. Clears buffer table entries
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { UsageBuffer } from './usageBuffer.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('usage-aggregator')

export class UsageAggregator {
  private cronJob: cron.ScheduledTask | null = null
  private usageBuffer: UsageBuffer
  private isProcessing = false

  constructor(
    // eslint-disable-next-line no-unused-vars
    private _prisma: PrismaClient,
    usageBuffer?: UsageBuffer
  ) {
    this.usageBuffer = usageBuffer || new UsageBuffer()
  }

  /**
   * Start the aggregator
   * Runs every minute at the top of the minute
   */
  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    // Run every minute (at second 0)
    this.cronJob = cron.schedule('* * * * *', async () => {
      await this.flush()
    })

    log.info('Started — flushes buffered usage every minute')
  }

  /**
   * Stop the aggregator
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /**
   * Flush buffered usage to database
   * This is the core operation that runs every minute
   */
  private async flush() {
    if (this.isProcessing) {
      log.info('Previous flush still processing, skipping')
      return
    }

    this.isProcessing = true
    const startTime = Date.now()

    try {
      // Get all buffered usage from buffer table
      const bufferedUsage = await this.usageBuffer.getAllBufferedUsage()

      if (bufferedUsage.size === 0) {
        log.info('No buffered usage to flush')
        this.isProcessing = false
        return
      }

      log.info({ userCount: bufferedUsage.size }, 'Flushing buffered usage')

      let successCount = 0
      let errorCount = 0
      const timestamp = new Date()

      // Process each user's buffered usage
      for (const [userId, metrics] of bufferedUsage.entries()) {
        try {
          // Find customer for this user
          const customer = await this._prisma.customer.findUnique({
            where: { userId },
            include: {
              subscriptions: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          })

          if (!customer) {
            log.warn({ userId }, 'Customer not found')
            errorCount++
            continue
          }

          // Get billing period from active subscription
          const subscription = customer.subscriptions[0]
          const periodStart = subscription?.currentPeriodStart || timestamp
          const periodEnd =
            subscription?.currentPeriodEnd ||
            new Date(timestamp.getTime() + 30 * 24 * 60 * 60 * 1000)

          // Get pricing from billing settings
          const settings = await this._prisma.billingSettings.findFirst()

          // Create usage records for each metric type
          const usageRecords = []

          if (metrics.bandwidth > 0) {
            const amount = settings?.bandwidthPerGBCents
              ? Math.ceil(metrics.bandwidth * settings.bandwidthPerGBCents)
              : undefined

            usageRecords.push({
              customerId: customer.id,
              type: 'BANDWIDTH' as const,
              metricType: 'bandwidth',
              resourceType: 'AGGREGATED',
              quantity: metrics.bandwidth,
              unit: 'GB',
              periodStart,
              periodEnd,
              recordedAt: timestamp,
              unitPrice: settings?.bandwidthPerGBCents ?? undefined,
              amount,
              timestamp,
              metadata: { aggregated: true, interval: '1min' },
            })
          }

          if (metrics.compute > 0) {
            const amount = settings?.computePerHourCents
              ? Math.ceil(metrics.compute * settings.computePerHourCents)
              : undefined

            usageRecords.push({
              customerId: customer.id,
              type: 'COMPUTE' as const,
              metricType: 'compute',
              resourceType: 'AGGREGATED',
              quantity: metrics.compute,
              unit: 'HOURS',
              periodStart,
              periodEnd,
              recordedAt: timestamp,
              unitPrice: settings?.computePerHourCents ?? undefined,
              amount,
              timestamp,
              metadata: { aggregated: true, interval: '1min' },
            })
          }

          if (metrics.requests > 0) {
            const amount = settings?.requestsPer1000Cents
              ? Math.ceil(
                  (metrics.requests / 1000) * settings.requestsPer1000Cents
                )
              : undefined

            usageRecords.push({
              customerId: customer.id,
              type: 'REQUESTS' as const,
              metricType: 'requests',
              resourceType: 'AGGREGATED',
              quantity: metrics.requests,
              unit: 'REQUESTS',
              periodStart,
              periodEnd,
              recordedAt: timestamp,
              unitPrice: settings?.requestsPer1000Cents ?? undefined,
              amount,
              timestamp,
              metadata: { aggregated: true, interval: '1min' },
            })
          }

          // Batch insert all usage records for this user
          if (usageRecords.length > 0) {
            await this._prisma.usageRecord.createMany({
              data: usageRecords,
            })
          }

          // Clear this user's buffer in buffer table
          await this.usageBuffer.clearUser(userId)

          successCount++
        } catch (error) {
          log.error({ userId, err: error }, 'Failed to flush usage for user')
          errorCount++
          // Continue processing other users even if one fails
        }
      }

      const duration = Date.now() - startTime
      log.info({ successCount, errorCount, durationMs: duration }, 'Flush completed')

      // Log stats for monitoring
      if (duration > 5000) {
        log.warn({ durationMs: duration }, 'Flush took too long — consider optimizing or scaling')
      }
    } catch (error) {
      log.error(error, 'Error during flush')
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * Manual flush trigger (for testing or maintenance)
   */
  async runNow() {
    log.info('Manual flush triggered')
    await this.flush()
  }

  /**
   * Get aggregator status
   */
  getStatus(): {
    isRunning: boolean
    isProcessing: boolean
  } {
    return {
      isRunning: this.cronJob !== null,
      isProcessing: this.isProcessing,
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    log.info('Shutting down')

    // Stop accepting new flush jobs
    this.stop()

    // Wait for current flush to complete (max 60 seconds for large batches)
    const maxWait = 60000
    const checkInterval = 100
    let waited = 0

    while (this.isProcessing && waited < maxWait) {
      await new Promise(resolve =>
        globalThis.setTimeout(resolve, checkInterval)
      )
      waited += checkInterval
    }

    if (this.isProcessing) {
      log.warn('Shutdown timeout — flush may be incomplete')
    }

    // Disconnect from database
    await this.usageBuffer.disconnect()

    log.info('Shutdown complete')
  }
}
