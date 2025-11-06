import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvoiceScheduler } from './invoiceScheduler.js';
import type { PrismaClient } from '@prisma/client';

// Mock node-cron
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((pattern, callback) => ({
      stop: vi.fn(),
      start: vi.fn(),
      destroy: vi.fn(),
    })),
  },
}));

// Mock InvoiceService
vi.mock('./invoiceService.js', () => ({
  InvoiceService: vi.fn().mockImplementation(() => ({
    generateInvoice: vi.fn().mockResolvedValue('invoice-123'),
  })),
}));

describe('InvoiceScheduler', () => {
  let scheduler: InvoiceScheduler;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      subscription: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    scheduler = new InvoiceScheduler(mockPrisma as PrismaClient);
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('start', () => {
    it('should start the cron scheduler at 2 AM', () => {
      const cron = require('node-cron').default;

      scheduler.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        '0 2 * * *', // 2 AM daily
        expect.any(Function)
      );
    });

    it('should not start if already running', () => {
      const cron = require('node-cron').default;

      scheduler.start();
      scheduler.start();

      // Should only be called once
      expect(cron.schedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should stop the scheduler', () => {
      scheduler.start();
      scheduler.stop();

      // Scheduler should be stopped
      scheduler.start();

      const cron = require('node-cron').default;
      expect(cron.schedule).toHaveBeenCalledTimes(2);
    });
  });

  describe('generateDueInvoices', () => {
    it('should generate invoices for subscriptions with ended periods', async () => {
      const now = new Date('2024-01-31T10:00:00Z');
      const yesterday = new Date('2024-01-30T10:00:00Z');

      const dueSubscriptions = [
        {
          id: 'sub-1',
          status: 'ACTIVE',
          currentPeriodEnd: new Date('2024-01-30T15:00:00Z'),
          customer: {
            user: {
              id: 'user-1',
              username: 'alice',
              email: 'alice@example.com',
            },
          },
        },
        {
          id: 'sub-2',
          status: 'ACTIVE',
          currentPeriodEnd: new Date('2024-01-30T18:00:00Z'),
          customer: {
            user: {
              id: 'user-2',
              username: 'bob',
              email: 'bob@example.com',
            },
          },
        },
      ];

      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockPrisma.subscription.findMany.mockResolvedValue(dueSubscriptions);
      mockPrisma.subscription.update.mockResolvedValue({});

      await scheduler.runNow();

      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          currentPeriodEnd: {
            gte: expect.any(Date),
            lt: expect.any(Date),
          },
        },
        include: {
          customer: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  email: true,
                },
              },
            },
          },
        },
      });

      const { InvoiceService } = await import('./invoiceService.js');
      const mockInvoiceService = vi.mocked(InvoiceService).mock.results[0].value;

      expect(mockInvoiceService.generateInvoice).toHaveBeenCalledTimes(2);
      expect(mockInvoiceService.generateInvoice).toHaveBeenCalledWith('sub-1');
      expect(mockInvoiceService.generateInvoice).toHaveBeenCalledWith('sub-2');

      vi.useRealTimers();
    });

    it('should update subscription periods after invoice generation', async () => {
      const subscription = {
        id: 'sub-1',
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2024-01-31T00:00:00Z'),
        currentPeriodStart: new Date('2024-01-01T00:00:00Z'),
        customer: {
          user: {
            id: 'user-1',
            username: 'alice',
            email: 'alice@example.com',
          },
        },
      };

      mockPrisma.subscription.findMany.mockResolvedValue([subscription]);
      mockPrisma.subscription.update.mockResolvedValue({});

      await scheduler.runNow();

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: {
          currentPeriodStart: subscription.currentPeriodEnd,
          currentPeriodEnd: expect.any(Date), // Next month
        },
      });
    });

    it('should handle no subscriptions due', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await scheduler.runNow();

      const { InvoiceService } = await import('./invoiceService.js');
      const mockInvoiceService = vi.mocked(InvoiceService).mock.results[0].value;

      expect(mockInvoiceService.generateInvoice).not.toHaveBeenCalled();
    });

    it('should continue processing if one invoice fails', async () => {
      const subscriptions = [
        {
          id: 'sub-1',
          status: 'ACTIVE',
          currentPeriodEnd: new Date('2024-01-30'),
          currentPeriodStart: new Date('2024-01-01'),
          customer: {
            user: { id: 'user-1', username: 'alice', email: 'alice@example.com' },
          },
        },
        {
          id: 'sub-2',
          status: 'ACTIVE',
          currentPeriodEnd: new Date('2024-01-30'),
          currentPeriodStart: new Date('2024-01-01'),
          customer: {
            user: { id: 'user-2', username: 'bob', email: 'bob@example.com' },
          },
        },
        {
          id: 'sub-3',
          status: 'ACTIVE',
          currentPeriodEnd: new Date('2024-01-30'),
          currentPeriodStart: new Date('2024-01-01'),
          customer: {
            user: { id: 'user-3', username: 'charlie', email: 'charlie@example.com' },
          },
        },
      ];

      mockPrisma.subscription.findMany.mockResolvedValue(subscriptions);
      mockPrisma.subscription.update.mockResolvedValue({});

      const { InvoiceService } = await import('./invoiceService.js');
      const mockInvoiceService = vi.mocked(InvoiceService).mock.results[0].value;

      // Mock second invoice to fail
      mockInvoiceService.generateInvoice
        .mockResolvedValueOnce('invoice-1')
        .mockRejectedValueOnce(new Error('Payment processor error'))
        .mockResolvedValueOnce('invoice-3');

      await scheduler.runNow();

      // All subscriptions should be attempted
      expect(mockInvoiceService.generateInvoice).toHaveBeenCalledTimes(3);

      // Only successful invoices should update subscriptions
      expect(mockPrisma.subscription.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sub-1' } })
      );
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sub-3' } })
      );
    });
  });

  describe('getNextPeriodEnd', () => {
    it('should calculate next billing period (one month later)', async () => {
      const subscription = {
        id: 'sub-1',
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2024-01-31T00:00:00Z'),
        currentPeriodStart: new Date('2024-01-01T00:00:00Z'),
        customer: {
          user: { id: 'user-1', username: 'alice', email: 'alice@example.com' },
        },
      };

      mockPrisma.subscription.findMany.mockResolvedValue([subscription]);
      mockPrisma.subscription.update.mockResolvedValue({});

      await scheduler.runNow();

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: {
          currentPeriodStart: new Date('2024-01-31T00:00:00Z'),
          currentPeriodEnd: new Date('2024-02-29T00:00:00Z'), // Leap year
        },
      });
    });
  });

  describe('runNow', () => {
    it('should trigger invoice generation immediately', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await scheduler.runNow();

      expect(mockPrisma.subscription.findMany).toHaveBeenCalled();
    });
  });

  describe('scheduler timing', () => {
    it('should be configured to run at 2 AM', () => {
      const cron = require('node-cron').default;

      scheduler.start();

      // Verify cron pattern is for 2 AM (0 2 * * *)
      expect(cron.schedule).toHaveBeenCalledWith(
        '0 2 * * *',
        expect.any(Function)
      );
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.subscription.findMany.mockRejectedValue(new Error('Database error'));

      await expect(scheduler.runNow()).resolves.not.toThrow();
    });

    it('should log errors but continue operation', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockPrisma.subscription.findMany.mockRejectedValue(new Error('Test error'));

      await scheduler.runNow();

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
