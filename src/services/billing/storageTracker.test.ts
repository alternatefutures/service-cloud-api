import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageTracker } from './storageTracker.js';
import type { PrismaClient } from '@prisma/client';

describe('StorageTracker', () => {
  let storageTracker: StorageTracker;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      pinnedContent: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        aggregate: vi.fn(),
        count: vi.fn(),
      },
      usageRecord: {
        create: vi.fn(),
        groupBy: vi.fn(),
      },
      storageSnapshot: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        upsert: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
      },
      customer: {
        findUnique: vi.fn(),
      },
      subscription: {
        findFirst: vi.fn(),
      },
      billingSettings: {
        findFirst: vi.fn(),
      },
    } as any;

    storageTracker = new StorageTracker(mockPrisma as PrismaClient);
  });

  describe('trackPinEvent', () => {
    it('should create pin record and usage record', async () => {
      const pinData = {
        id: 'pin-123',
        userId: 'user-123',
        cid: 'QmTest123',
        sizeBytes: BigInt(1024 * 1024 * 100), // 100 MB
        pinnedAt: new Date(),
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        metadata: { source: 'upload' },
      };

      mockPrisma.pinnedContent.create.mockResolvedValue(pinData);
      mockPrisma.customer.findUnique.mockResolvedValue({
        id: 'cust-123',
        userId: 'user-123',
      });
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      });
      mockPrisma.usageRecord.create.mockResolvedValue({
        id: 'usage-123',
        userId: 'user-123',
        type: 'STORAGE',
      });

      const result = await storageTracker.trackPinEvent(
        'user-123',
        'QmTest123',
        1024 * 1024 * 100,
        'test.jpg',
        'image/jpeg',
        { source: 'upload' }
      );

      expect(result).toBe('pin-123');
      expect(mockPrisma.pinnedContent.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          cid: 'QmTest123',
          sizeBytes: BigInt(1024 * 1024 * 100),
          filename: 'test.jpg',
          mimeType: 'image/jpeg',
          metadata: { source: 'upload' },
        },
      });
      expect(mockPrisma.usageRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          type: 'STORAGE',
          resourceType: 'IPFS',
          resourceId: 'QmTest123',
          unit: 'GB',
          quantity: expect.any(Number),
          periodStart: expect.any(Date),
          periodEnd: expect.any(Date),
          metadata: expect.objectContaining({
            cid: 'QmTest123',
            filename: 'test.jpg',
            action: 'pin',
            sizeBytes: 1024 * 1024 * 100,
          }),
        }),
      });
    });

    it('should handle pin event without metadata', async () => {
      const pinData = {
        id: 'pin-456',
        userId: 'user-456',
        cid: 'QmTest456',
        sizeBytes: BigInt(1024 * 1024 * 50),
        pinnedAt: new Date(),
      };

      mockPrisma.pinnedContent.create.mockResolvedValue(pinData);
      mockPrisma.customer.findUnique.mockResolvedValue({
        id: 'cust-456',
        userId: 'user-456',
      });
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-456',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      });
      mockPrisma.usageRecord.create.mockResolvedValue({
        id: 'usage-456',
        userId: 'user-456',
        type: 'STORAGE',
      });

      const result = await storageTracker.trackPinEvent('user-456', 'QmTest456', 1024 * 1024 * 50);

      expect(result).toBe('pin-456');
      expect(mockPrisma.pinnedContent.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-456',
          cid: 'QmTest456',
          sizeBytes: BigInt(1024 * 1024 * 50),
          filename: undefined,
          mimeType: undefined,
          metadata: undefined,
        },
      });
    });
  });

  describe('trackUnpinEvent', () => {
    it('should update pin record and create negative usage record', async () => {
      const existingPin = {
        id: 'pin-123',
        userId: 'user-123',
        cid: 'QmTest123',
        sizeBytes: BigInt(1024 * 1024 * 100),
        pinnedAt: new Date(),
        unpinnedAt: null,
      };

      mockPrisma.pinnedContent.findFirst.mockResolvedValue(existingPin);
      mockPrisma.pinnedContent.update.mockResolvedValue({
        ...existingPin,
        unpinnedAt: new Date(),
      });
      mockPrisma.customer.findUnique.mockResolvedValue({
        id: 'cust-123',
        userId: 'user-123',
      });
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-123',
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      });
      mockPrisma.usageRecord.create.mockResolvedValue({
        id: 'usage-unpin-123',
        userId: 'user-123',
        type: 'STORAGE',
      });

      const result = await storageTracker.trackUnpinEvent('user-123', 'QmTest123');

      expect(result).toBe(true);
      expect(mockPrisma.pinnedContent.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          cid: 'QmTest123',
          unpinnedAt: null,
        },
      });
      expect(mockPrisma.pinnedContent.update).toHaveBeenCalledWith({
        where: { id: 'pin-123' },
        data: { unpinnedAt: expect.any(Date) },
      });
      expect(mockPrisma.usageRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          type: 'STORAGE',
          resourceType: 'IPFS',
          resourceId: 'QmTest123',
          unit: 'GB',
          quantity: expect.any(Number), // Should be negative for unpin
          periodStart: expect.any(Date),
          periodEnd: expect.any(Date),
          metadata: expect.objectContaining({
            cid: 'QmTest123',
            action: 'unpin',
            sizeBytes: 1024 * 1024 * 100,
          }),
        }),
      });
    });

    it('should return false if pin not found', async () => {
      mockPrisma.pinnedContent.findFirst.mockResolvedValue(null);

      const result = await storageTracker.trackUnpinEvent('user-123', 'QmNonExistent');

      expect(result).toBe(false);
      expect(mockPrisma.pinnedContent.update).not.toHaveBeenCalled();
      expect(mockPrisma.usageRecord.create).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentStorage', () => {
    it('should return total bytes of active pins', async () => {
      mockPrisma.pinnedContent.aggregate.mockResolvedValue({
        _sum: {
          sizeBytes: BigInt(1024 * 1024 * 500), // 500 MB
        },
      });

      const result = await storageTracker.getCurrentStorage('user-123');

      expect(result).toBe(BigInt(1024 * 1024 * 500));
      expect(mockPrisma.pinnedContent.aggregate).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          unpinnedAt: null,
        },
        _sum: {
          sizeBytes: true,
        },
      });
    });

    it('should return 0 if no pins', async () => {
      mockPrisma.pinnedContent.aggregate.mockResolvedValue({
        _sum: {
          sizeBytes: null,
        },
      });

      const result = await storageTracker.getCurrentStorage('user-123');

      expect(result).toBe(BigInt(0));
    });
  });

  describe('getPinCount', () => {
    it('should return count of active pins', async () => {
      mockPrisma.pinnedContent.count.mockResolvedValue(15);

      const result = await storageTracker.getPinCount('user-123');

      expect(result).toBe(15);
      expect(mockPrisma.pinnedContent.count).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          unpinnedAt: null,
        },
      });
    });
  });

  describe('getActivePins', () => {
    it('should return list of active pins', async () => {
      const pins = [
        {
          id: 'pin-1',
          cid: 'QmTest1',
          sizeBytes: BigInt(1024 * 1024 * 50),
          pinnedAt: new Date(),
          filename: 'file1.jpg',
        },
        {
          id: 'pin-2',
          cid: 'QmTest2',
          sizeBytes: BigInt(1024 * 1024 * 75),
          pinnedAt: new Date(),
          filename: 'file2.png',
        },
      ];

      mockPrisma.pinnedContent.findMany.mockResolvedValue(pins);

      const result = await storageTracker.getActivePins('user-123', 50);

      expect(result).toEqual(pins);
      expect(mockPrisma.pinnedContent.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          unpinnedAt: null,
        },
        orderBy: {
          pinnedAt: 'desc',
        },
        take: 50,
      });
    });
  });

  describe('calculateStorageForPeriod', () => {
    it('should calculate GB-hours for billing period', async () => {
      const periodStart = new Date('2024-01-01T00:00:00Z');
      const periodEnd = new Date('2024-01-31T23:59:59Z');

      const pins = [
        {
          id: 'pin-1',
          cid: 'QmTest1',
          sizeBytes: BigInt(1024 * 1024 * 1024 * 10), // 10 GB
          pinnedAt: new Date('2023-12-15T00:00:00Z'), // Before period
          unpinnedAt: null, // Still active
        },
        {
          id: 'pin-2',
          cid: 'QmTest2',
          sizeBytes: BigInt(1024 * 1024 * 1024 * 5), // 5 GB
          pinnedAt: new Date('2024-01-15T12:00:00Z'), // Mid period
          unpinnedAt: new Date('2024-01-25T12:00:00Z'), // Unpinned during period
        },
      ];

      mockPrisma.pinnedContent.findMany.mockResolvedValue(pins);

      const result = await storageTracker.calculateStorageForPeriod('user-123', periodStart, periodEnd);

      // Result should be in GB-hours
      expect(result).toBeGreaterThan(0);
      expect(mockPrisma.pinnedContent.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          OR: expect.any(Array),
          pinnedAt: expect.any(Object),
        },
      });
    });

    it('should return 0 for period with no pins', async () => {
      mockPrisma.pinnedContent.findMany.mockResolvedValue([]);

      const result = await storageTracker.calculateStorageForPeriod(
        'user-123',
        new Date('2024-01-01'),
        new Date('2024-01-31')
      );

      expect(result).toBe(0);
    });
  });

  describe('createDailySnapshot', () => {
    it('should create snapshot with current storage stats', async () => {
      const snapshotDate = new Date('2024-01-15T00:00:00Z');

      mockPrisma.pinnedContent.aggregate.mockResolvedValue({
        _sum: {
          sizeBytes: BigInt(1024 * 1024 * 1024 * 50), // 50 GB
        },
      });

      mockPrisma.pinnedContent.count.mockResolvedValue(25);

      const createdSnapshot = {
        id: 'snapshot-123',
        userId: 'user-123',
        date: snapshotDate,
        totalBytes: BigInt(1024 * 1024 * 1024 * 50),
        pinCount: 25,
        createdAt: new Date(),
      };

      mockPrisma.storageSnapshot.upsert.mockResolvedValue(createdSnapshot);

      const result = await storageTracker.createDailySnapshot('user-123', snapshotDate);

      expect(result).toBe('snapshot-123');
      expect(mockPrisma.storageSnapshot.upsert).toHaveBeenCalledWith({
        where: {
          userId_date: {
            userId: 'user-123',
            date: expect.any(Date),
          },
        },
        create: {
          userId: 'user-123',
          date: expect.any(Date),
          totalBytes: BigInt(1024 * 1024 * 1024 * 50),
          pinCount: 25,
        },
        update: {
          totalBytes: BigInt(1024 * 1024 * 1024 * 50),
          pinCount: 25,
        },
      });
    });

    it('should use current date if not provided', async () => {
      mockPrisma.pinnedContent.aggregate.mockResolvedValue({
        _sum: { sizeBytes: BigInt(0) },
      });
      mockPrisma.pinnedContent.count.mockResolvedValue(0);
      mockPrisma.storageSnapshot.upsert.mockResolvedValue({
        id: 'snapshot-456',
        userId: 'user-123',
      });

      const result = await storageTracker.createDailySnapshot('user-123');

      expect(result).toBe('snapshot-456');
      expect(mockPrisma.storageSnapshot.upsert).toHaveBeenCalled();
    });
  });

  describe('getSnapshots', () => {
    it('should return snapshots within date range', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');

      const snapshots = [
        {
          id: 'snapshot-1',
          userId: 'user-123',
          date: new Date('2024-01-05'),
          totalBytes: BigInt(1024 * 1024 * 1024 * 40),
          pinCount: 20,
        },
        {
          id: 'snapshot-2',
          userId: 'user-123',
          date: new Date('2024-01-15'),
          totalBytes: BigInt(1024 * 1024 * 1024 * 45),
          pinCount: 22,
        },
      ];

      mockPrisma.storageSnapshot.findMany.mockResolvedValue(snapshots);

      const result = await storageTracker.getSnapshots('user-123', startDate, endDate);

      expect(result).toEqual(snapshots);
      expect(mockPrisma.storageSnapshot.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: {
          date: 'asc',
        },
      });
    });
  });
});
