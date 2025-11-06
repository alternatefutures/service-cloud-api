/**
 * Invoice Scheduler
 *
 * Automatically generates invoices when billing periods end
 * Runs daily at 2 AM to check for subscriptions that need invoicing
 */

import cron from 'node-cron';
import type { PrismaClient } from '@prisma/client';
import { InvoiceService } from './invoiceService.js';

export class InvoiceScheduler {
  private invoiceService: InvoiceService;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(private prisma: PrismaClient) {
    this.invoiceService = new InvoiceService(prisma);
  }

  /**
   * Start the scheduler
   * Runs daily at 2 AM
   */
  start() {
    if (this.cronJob) {
      console.log('[Invoice Scheduler] Already running');
      return;
    }

    // Run daily at 2 AM
    this.cronJob = cron.schedule('0 2 * * *', async () => {
      await this.generateDueInvoices();
    });

    console.log('[Invoice Scheduler] Started - runs daily at 2 AM');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('[Invoice Scheduler] Stopped');
    }
  }

  /**
   * Generate invoices for subscriptions with ended billing periods
   */
  private async generateDueInvoices() {
    const startTime = Date.now();
    console.log('[Invoice Scheduler] Checking for subscriptions due for invoicing...');

    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

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
      });

      if (dueSubscriptions.length === 0) {
        console.log('[Invoice Scheduler] No subscriptions due for invoicing');
        return;
      }

      console.log(`[Invoice Scheduler] Found ${dueSubscriptions.length} subscriptions to invoice`);

      let successCount = 0;
      let errorCount = 0;

      for (const subscription of dueSubscriptions) {
        try {
          // Generate invoice
          const invoiceId = await this.invoiceService.generateInvoice(subscription.id);
          console.log(
            `[Invoice Scheduler] Generated invoice ${invoiceId} for subscription ${subscription.id} (user: ${subscription.customer.user.username || subscription.customer.user.email})`
          );

          // Update subscription to next billing period
          const nextPeriodStart = subscription.currentPeriodEnd;
          const nextPeriodEnd = this.getNextPeriodEnd(subscription.currentPeriodEnd);

          await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              currentPeriodStart: nextPeriodStart,
              currentPeriodEnd: nextPeriodEnd,
            },
          });

          successCount++;
        } catch (error) {
          console.error(
            `[Invoice Scheduler] Failed to generate invoice for subscription ${subscription.id}:`,
            error
          );
          errorCount++;
        }
      }

      const duration = Date.now() - startTime;
      console.log(
        `[Invoice Scheduler] Completed: ${successCount} invoices generated, ${errorCount} failed (${duration}ms)`
      );
    } catch (error) {
      console.error('[Invoice Scheduler] Error generating invoices:', error);
    }
  }

  /**
   * Calculate next billing period end date
   * Adds one month to current period end
   */
  private getNextPeriodEnd(currentEnd: Date): Date {
    const next = new Date(currentEnd);
    next.setMonth(next.getMonth() + 1);
    return next;
  }

  /**
   * Run invoice generation immediately (for testing/manual triggering)
   */
  async runNow() {
    console.log('[Invoice Scheduler] Manual trigger - generating invoices now');
    await this.generateDueInvoices();
  }
}
