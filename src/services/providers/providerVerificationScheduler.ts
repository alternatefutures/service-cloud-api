/**
 * Provider Verification Scheduler
 *
 * Runs the full provider verification suite once daily at 4 AM UTC.
 * After verification, syncs results to the staging database.
 *
 * Guards:
 *   - Overlap: skips if a previous run is still in progress
 *   - Balance: skips if ACT balance is below the minimum threshold
 *   - Environment: skips if AKASH_MNEMONIC is not set (non-Akash deployments)
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import {
  runVerificationSuite,
  syncToStaging,
  checkBalance,
} from './providerVerification.js'

const log = createLogger('provider-verification-scheduler')

const MIN_ACT_BALANCE_UACT = 5_000_000

export class ProviderVerificationScheduler {
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
      log.warn('AKASH_MNEMONIC not set — provider verification scheduler disabled')
      return
    }

    // Daily at 4:00 AM UTC
    this.cronJob = cron.schedule('0 4 * * *', () => {
      this.runVerification().catch(err => {
        log.error({ err: err instanceof Error ? err.message : err }, 'Daily verification failed')
      })
    })

    log.info('Started — runs daily at 04:00 UTC')
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /** Trigger a verification run manually (e.g. from an internal endpoint). */
  async runNow(): Promise<void> {
    await this.runVerification()
  }

  private async runVerification(): Promise<void> {
    if (this.running) {
      log.warn('Skipping — previous verification still in progress')
      return
    }

    this.running = true
    const start = Date.now()

    try {
      // Pre-flight: check ACT balance
      const balance = await checkBalance()
      log.info({ akt: balance.akt, act: balance.act }, 'Wallet balance')

      if (balance.uact < MIN_ACT_BALANCE_UACT) {
        log.warn(
          { uact: balance.uact, minimum: MIN_ACT_BALANCE_UACT },
          'Insufficient ACT balance — skipping verification'
        )
        return
      }

      const summary = await runVerificationSuite(this.prisma)

      log.info({
        runId: summary.runId,
        durationMs: Date.now() - start,
        templatesPassed: summary.templatesPassed,
        templatesTotal: summary.templatesTotal,
        deployments: summary.deployments,
        uniqueProviders: summary.uniqueProviders,
        costUakt: summary.costUakt.toString(),
        costUact: summary.costUact.toString(),
      }, 'Verification run complete')

      // Sync results to staging
      try {
        await syncToStaging(this.prisma)
      } catch (syncErr) {
        log.error(
          { err: syncErr instanceof Error ? syncErr.message : syncErr },
          'Staging sync failed (verification results are still in production DB)'
        )
      }
    } finally {
      this.running = false
      log.info({ durationMs: Date.now() - start }, 'Verification run finished')
    }
  }
}
