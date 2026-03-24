/**
 * Storage Snapshot Scheduler
 *
 * Creates daily snapshots of storage usage for all users
 * Runs daily at midnight
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { StorageTracker } from './storageTracker.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('storage-snapshot-scheduler')

export class StorageSnapshotScheduler {
  private storageTracker: StorageTracker
  private cronJob: cron.ScheduledTask | null = null

  constructor(private prisma: PrismaClient) {
    this.storageTracker = new StorageTracker(prisma)
  }

  /**
   * Start the scheduler
   * Runs daily at midnight (00:00)
   */
  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    // Run daily at midnight
    this.cronJob = cron.schedule('0 0 * * *', async () => {
      await this.createSnapshots()
    })

    log.info('Started — runs daily at midnight')
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /**
   * Create snapshots for all users
   */
  private async createSnapshots() {
    const startTime = Date.now()
    log.info('Starting daily snapshot creation')

    try {
      // Get all users
      const users = await this.prisma.user.findMany({
        select: { id: true, username: true },
      })

      let successCount = 0
      let errorCount = 0

      for (const user of users) {
        try {
          await this.storageTracker.createDailySnapshot(user.id)
          successCount++
        } catch (error) {
          log.error({ userId: user.id, err: error }, 'Failed to create snapshot for user')
          errorCount++
        }
      }

      const duration = Date.now() - startTime
      log.info({ successCount, errorCount, durationMs: duration }, 'Snapshot creation completed')
    } catch (error) {
      log.error(error, 'Error creating snapshots')
    }
  }

  /**
   * Run snapshot creation immediately (for testing/manual triggering)
   */
  async runNow() {
    log.info('Manual trigger — creating snapshots now')
    await this.createSnapshots()
  }
}
