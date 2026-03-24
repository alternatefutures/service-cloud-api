/**
 * Invoice Scheduler
 *
 * Automatically generates invoices when billing periods end
 * Runs daily at 2 AM to check for subscriptions that need invoicing
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { InvoiceService } from './invoiceService.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('invoice-scheduler')

export class InvoiceScheduler {
  private invoiceService: InvoiceService
  private cronJob: cron.ScheduledTask | null = null

  constructor(private prisma: PrismaClient) {
    this.invoiceService = new InvoiceService(prisma)
  }

  /**
   * Start the scheduler
   * Runs daily at 2 AM
   */
  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    // Run daily at 2 AM
    this.cronJob = cron.schedule('0 2 * * *', async () => {
      await this.generateDueInvoices()
    })

    log.info('Started — runs daily at 2 AM')
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
   * Generate invoices for subscriptions with ended billing periods
   */
  private async generateDueInvoices() {
    const startTime = Date.now()
    log.info('Checking for subscriptions due for invoicing')

    try {
      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      // Find active subscriptions where billing period just ended
      const dueSubscriptions = await this.prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          currentPeriodEnd: {
            gte: yesterday,
            lt: now,
          },
        },
        include: {
          customer: {
            include: {
              user: {
                select: { id: true, username: true, email: true },
              },
            },
          },
        },
      })

      if (dueSubscriptions.length === 0) {
        log.info('No subscriptions due for invoicing')
        return
      }

      log.info({ count: dueSubscriptions.length }, 'Found subscriptions to invoice')

      let successCount = 0
      let errorCount = 0

      for (const subscription of dueSubscriptions) {
        try {
          // Generate invoice
          const invoiceId = await this.invoiceService.generateInvoice(
            subscription.id
          )
          log.info(
            {
              invoiceId,
              subscriptionId: subscription.id,
              user: subscription.customer.user.username || subscription.customer.user.email,
            },
            'Generated invoice'
          )

          // Update subscription to next billing period
          const nextPeriodStart = subscription.currentPeriodEnd
          const nextPeriodEnd = this.getNextPeriodEnd(
            subscription.currentPeriodEnd
          )

          await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              currentPeriodStart: nextPeriodStart,
              currentPeriodEnd: nextPeriodEnd,
            },
          })

          successCount++
        } catch (error) {
          log.error({ subscriptionId: subscription.id, err: error }, 'Failed to generate invoice')
          errorCount++
        }
      }

      const duration = Date.now() - startTime
      log.info({ successCount, errorCount, durationMs: duration }, 'Invoice generation completed')
    } catch (error) {
      log.error(error, 'Error generating invoices')
    }
  }

  /**
   * Calculate next billing period end date
   * Adds one month to current period end
   */
  private getNextPeriodEnd(currentEnd: Date): Date {
    const next = new Date(currentEnd)
    next.setMonth(next.getMonth() + 1)
    return next
  }

  /**
   * Run invoice generation immediately (for testing/manual triggering)
   */
  async runNow() {
    log.info('Manual trigger — generating invoices now')
    await this.generateDueInvoices()
  }
}
