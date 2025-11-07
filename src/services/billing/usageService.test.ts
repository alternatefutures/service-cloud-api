import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageService } from './usageService.js';
import type { PrismaClient } from '@prisma/client';

describe('UsageService', () => {
  let service: UsageService;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock Prisma client
    mockPrisma = {
      customer: {
        findUnique: vi.fn(),
      },
      subscription: {
        findFirst: vi.fn(),
      },
      usageRecord: {
        create: vi.fn(),
        findMany: vi.fn(),
        groupBy: vi.fn(),
      },
      billingSettings: {
        findFirst: vi.fn(),
      },
    } as any;

    service = new UsageService(mockPrisma as PrismaClient);
  });

  describe('recordUsage', () => {
    it('should record storage usage', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const subscription = {
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      };
      const createdUsage = {
        id: 'usage-123',
        customerId: 'cust-123',
        type: 'STORAGE',
        quantity: 1024,
        unit: 'GB',
        resourceType: 'IPFS',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findFirst.mockResolvedValue(subscription);
      mockPrisma.usageRecord.create.mockResolvedValue(createdUsage);

      const result = await service.recordUsage(
        'user-123',
        'STORAGE',
        1024,
        'GB',
        'IPFS',
        'resource-123'
      );

      expect(result).toBe('usage-123');
      expect(mockPrisma.usageRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          type: 'STORAGE',
          quantity: 1024,
          unit: 'GB',
          resourceType: 'IPFS',
          resourceId: 'resource-123',
          metadata: undefined,
        }),
      });
    });

    it('should record bandwidth usage', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const subscription = {
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      };
      const createdUsage = {
        id: 'usage-456',
        type: 'BANDWIDTH',
        quantity: 500,
        unit: 'GB',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findFirst.mockResolvedValue(subscription);
      mockPrisma.usageRecord.create.mockResolvedValue(createdUsage);

      const result = await service.recordUsage(
        'user-123',
        'BANDWIDTH',
        500,
        'GB',
        'CDN'
      );

      expect(result).toBe('usage-456');
    });

    it('should record compute usage with metadata', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const subscription = {
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      };
      const metadata = { functionName: 'test-function', invocations: 1000 };
      const createdUsage = {
        id: 'usage-789',
        type: 'COMPUTE',
        metadata,
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findFirst.mockResolvedValue(subscription);
      mockPrisma.usageRecord.create.mockResolvedValue(createdUsage);

      const result = await service.recordUsage(
        'user-123',
        'COMPUTE',
        10.5,
        'hours',
        'Functions',
        'func-123',
        metadata
      );

      expect(result).toBe('usage-789');
      expect(mockPrisma.usageRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata,
        }),
      });
    });

    it('should throw error if customer not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(
        service.recordUsage('user-123', 'STORAGE', 100, 'GB', 'IPFS')
      ).rejects.toThrow('Customer not found');
    });
  });

  describe('getUsageForPeriod', () => {
    it('should calculate usage for period with billing settings', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const billingSettings = {
        storagePerGBCents: 10,
        bandwidthPerGBCents: 5,
        computePerHourCents: 20,
        requestsPer1000Cents: 1,
      };

      const groupedUsage = [
        { type: 'STORAGE', _sum: { quantity: 150, amount: 1500 } },
        { type: 'BANDWIDTH', _sum: { quantity: 200, amount: 1000 } },
        { type: 'COMPUTE', _sum: { quantity: 10, amount: 200 } },
        { type: 'REQUESTS', _sum: { quantity: 5000, amount: 5 } },
      ];

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.billingSettings.findFirst.mockResolvedValue(billingSettings);
      mockPrisma.usageRecord.groupBy.mockResolvedValue(groupedUsage);

      const periodStart = new Date('2025-01-01');
      const periodEnd = new Date('2025-01-31');

      const result = await service.getUsageForPeriod('user-123', periodStart, periodEnd);

      expect(result).toEqual({
        storage: {
          quantity: 150, // 100 + 50
          amount: 1500, // 150 * 10
        },
        bandwidth: {
          quantity: 200,
          amount: 1000, // 200 * 5
        },
        compute: {
          quantity: 10,
          amount: 200, // 10 * 20
        },
        requests: {
          quantity: 5000,
          amount: 5, // 5000 / 1000 * 1
        },
        total: 2705,
      });
    });

    it('should use default billing settings if none configured', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const groupedUsage = [
        { type: 'STORAGE', _sum: { quantity: 100, amount: 1000 } },
      ];

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.billingSettings.findFirst.mockResolvedValue(null);
      mockPrisma.usageRecord.groupBy.mockResolvedValue(groupedUsage);

      const periodStart = new Date('2025-01-01');
      const periodEnd = new Date('2025-01-31');

      const result = await service.getUsageForPeriod('user-123', periodStart, periodEnd);

      // Should use default rates
      expect(result.storage.amount).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
    });

    it('should return zero usage when no records exist', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const billingSettings = {
        storagePerGBCents: 10,
        bandwidthPerGBCents: 5,
        computePerHourCents: 20,
        requestsPer1000Cents: 1,
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.billingSettings.findFirst.mockResolvedValue(billingSettings);
      mockPrisma.usageRecord.groupBy.mockResolvedValue([]);

      const periodStart = new Date('2025-01-01');
      const periodEnd = new Date('2025-01-31');

      const result = await service.getUsageForPeriod('user-123', periodStart, periodEnd);

      expect(result).toEqual({
        storage: { quantity: 0, amount: 0 },
        bandwidth: { quantity: 0, amount: 0 },
        compute: { quantity: 0, amount: 0 },
        requests: { quantity: 0, amount: 0 },
        total: 0,
      });
    });
  });

  describe('getCurrentUsage', () => {
    it('should get usage for current billing period', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const subscription = {
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      };
      const billingSettings = {
        storagePerGBCents: 10,
        bandwidthPerGBCents: 5,
        computePerHourCents: 20,
        requestsPer1000Cents: 1,
      };

      const groupedUsage = [
        { type: 'STORAGE', _sum: { quantity: 50, amount: 500 } },
        { type: 'BANDWIDTH', _sum: { quantity: 100, amount: 500 } },
      ];

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findFirst.mockResolvedValue(subscription);
      mockPrisma.billingSettings.findFirst.mockResolvedValue(billingSettings);
      mockPrisma.usageRecord.groupBy.mockResolvedValue(groupedUsage);

      const result = await service.getCurrentUsage('user-123');

      expect(result.storage.quantity).toBe(50);
      expect(result.storage.amount).toBe(500);
      expect(result.bandwidth.quantity).toBe(100);
      expect(result.bandwidth.amount).toBe(500);
      expect(result.total).toBe(1000);
    });

    it('should throw error if customer not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentUsage('user-123')).rejects.toThrow('Customer not found');
    });
  });
});
