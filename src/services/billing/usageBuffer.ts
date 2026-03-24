/**
 * Usage Buffer Service
 *
 * Buffers usage metrics in PostgreSQL before flushing to the main usage table.
 * Reduces main table writes by batching per-request increments into per-minute aggregates.
 *
 * Implementation:
 * - Uses existing PostgreSQL (no Redis or external cache)
 * - No data loss on restart (buffer persisted in DB)
 * - Atomic increments via PostgreSQL ON CONFLICT UPSERT
 */

import { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('usage-buffer')

export type UsageType = 'BANDWIDTH' | 'COMPUTE' | 'REQUESTS'

const prisma = new PrismaClient()

export class UsageBuffer {
  private flushInterval: NodeJS.Timeout | null = null

  constructor() {
    log.info('Initialized with PostgreSQL buffer table')
  }

  /**
   * Increment usage counter in buffer table
   * Uses PostgreSQL UPSERT for atomic increments
   */
  async increment(
    userId: string,
    type: UsageType,
    quantity: number,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const field = type.toLowerCase() as 'bandwidth' | 'compute' | 'requests'

      // UPSERT: Insert or increment atomically
      // This is fast in PostgreSQL (ACID transactions)
      await prisma.$executeRaw`
        INSERT INTO "UsageBuffer" ("userId", "bandwidth", "compute", "requests", "updatedAt")
        VALUES (${userId},
                ${field === 'bandwidth' ? quantity : 0},
                ${field === 'compute' ? quantity : 0},
                ${field === 'requests' ? quantity : 0},
                NOW())
        ON CONFLICT ("userId")
        DO UPDATE SET
          "bandwidth" = "UsageBuffer"."bandwidth" + ${field === 'bandwidth' ? quantity : 0},
          "compute" = "UsageBuffer"."compute" + ${field === 'compute' ? quantity : 0},
          "requests" = "UsageBuffer"."requests" + ${field === 'requests' ? quantity : 0},
          "updatedAt" = NOW()
      `

      // Store metadata separately if provided (for debugging/auditing)
      if (metadata && Object.keys(metadata).length > 0) {
        await prisma.usageMetadata.create({
          data: {
            userId,
            type,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            metadata: metadata as any,
            createdAt: new Date(),
          },
        })
      }
    } catch (error) {
      log.error(error, 'Failed to increment usage')
    }
  }

  /**
   * Get all buffered usage data
   * Used by the aggregator to flush to database
   */
  async getAllBufferedUsage(): Promise<
    Map<
      string,
      {
        bandwidth: number
        compute: number
        requests: number
      }
    >
  > {
    try {
      const buffered = await prisma.usageBuffer.findMany()

      const result = new Map()

      for (const entry of buffered) {
        result.set(entry.userId, {
          bandwidth: entry.bandwidth,
          compute: entry.compute,
          requests: entry.requests,
        })
      }

      return result
    } catch (error) {
      log.error(error, 'Failed to get buffered usage')
      return new Map()
    }
  }

  /**
   * Clear buffered usage for a user
   * Called after successfully flushing to database
   */
  async clearUser(userId: string): Promise<void> {
    try {
      // Delete from buffer table
      await prisma.usageBuffer.delete({
        where: { userId },
      })

      // Clean up old metadata (older than 5 minutes)
      await prisma.usageMetadata.deleteMany({
        where: {
          userId,
          createdAt: {
            lt: new Date(Date.now() - 5 * 60 * 1000),
          },
        },
      })
    } catch (error) {
      log.error(error, 'Failed to clear user buffer')
    }
  }

  /**
   * Get current buffer stats (for monitoring)
   */
  async getStats(): Promise<{
    activeUsers: number
    totalBandwidth: number
    totalCompute: number
    totalRequests: number
  }> {
    try {
      const bufferedUsage = await this.getAllBufferedUsage()

      let totalBandwidth = 0
      let totalCompute = 0
      let totalRequests = 0

      for (const metrics of bufferedUsage.values()) {
        totalBandwidth += metrics.bandwidth
        totalCompute += metrics.compute
        totalRequests += metrics.requests
      }

      return {
        activeUsers: bufferedUsage.size,
        totalBandwidth,
        totalCompute,
        totalRequests,
      }
    } catch (error) {
      log.error(error, 'Failed to get stats')
      return {
        activeUsers: 0,
        totalBandwidth: 0,
        totalCompute: 0,
        totalRequests: 0,
      }
    }
  }

  /**
   * Health check - verify database connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`
      return true
    } catch (error) {
      log.error(error, 'Health check failed')
      return false
    }
  }

  /**
   * Graceful shutdown
   */
  async disconnect(): Promise<void> {
    try {
      if (this.flushInterval) {
        // eslint-disable-next-line no-undef
        clearInterval(this.flushInterval)
      }
      await prisma.$disconnect()
      log.info('Disconnected from database')
    } catch (error) {
      log.error(error, 'Error disconnecting')
    }
  }
}
