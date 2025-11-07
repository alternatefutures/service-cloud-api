/**
 * Storage Snapshot Scheduler
 *
 * Creates daily snapshots of storage usage for all users
 * Runs daily at midnight
 */

import * as cron from 'node-cron';
import type { PrismaClient } from '@prisma/client';
import { StorageTracker } from './storageTracker.js';

export class StorageSnapshotScheduler {
  private storageTracker: StorageTracker;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(private prisma: PrismaClient) {
    this.storageTracker = new StorageTracker(prisma);
  }

  /**
   * Start the scheduler
   * Runs daily at midnight (00:00)
   */
  start() {
    if (this.cronJob) {
      console.log('[Storage Snapshot Scheduler] Already running');
      return;
    }

    // Run daily at midnight
    this.cronJob = cron.schedule('0 0 * * *', async () => {
      await this.createSnapshots();
    });

    console.log('[Storage Snapshot Scheduler] Started - runs daily at midnight');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('[Storage Snapshot Scheduler] Stopped');
    }
  }

  /**
   * Create snapshots for all users
   */
  private async createSnapshots() {
    const startTime = Date.now();
    console.log('[Storage Snapshot Scheduler] Starting daily snapshot creation...');

    try {
      // Get all users
      const users = await this.prisma.user.findMany({
        select: { id: true, username: true },
      });

      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          await this.storageTracker.createDailySnapshot(user.id);
          successCount++;
        } catch (error) {
          console.error(
            `[Storage Snapshot Scheduler] Failed to create snapshot for user ${user.id}:`,
            error
          );
          errorCount++;
        }
      }

      const duration = Date.now() - startTime;
      console.log(
        `[Storage Snapshot Scheduler] Completed: ${successCount} successful, ${errorCount} failed (${duration}ms)`
      );
    } catch (error) {
      console.error('[Storage Snapshot Scheduler] Error creating snapshots:', error);
    }
  }

  /**
   * Run snapshot creation immediately (for testing/manual triggering)
   */
  async runNow() {
    console.log('[Storage Snapshot Scheduler] Manual trigger - creating snapshots now');
    await this.createSnapshots();
  }
}
