import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StorageSnapshotScheduler } from './storageSnapshotScheduler.js';
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

// Mock StorageTracker
vi.mock('./storageTracker.js', () => ({
  StorageTracker: vi.fn().mockImplementation(() => ({
    createDailySnapshot: vi.fn().mockResolvedValue('snapshot-123'),
  })),
}));

describe('StorageSnapshotScheduler', () => {
  let scheduler: StorageSnapshotScheduler;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      user: {
        findMany: vi.fn(),
      },
    } as any;

    scheduler = new StorageSnapshotScheduler(mockPrisma as PrismaClient);
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('start', () => {
    it('should start the cron scheduler', () => {
      const cron = require('node-cron').default;

      scheduler.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        '0 0 * * *', // Midnight daily
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

      // Scheduler should be stopped (tested via start not being called twice)
      scheduler.start();

      const cron = require('node-cron').default;
      expect(cron.schedule).toHaveBeenCalledTimes(2); // First start + restart after stop
    });

    it('should do nothing if not running', () => {
      scheduler.stop(); // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('createSnapshots', () => {
    it('should create snapshots for all users', async () => {
      const users = [
        { id: 'user-1', username: 'alice', email: 'alice@example.com' },
        { id: 'user-2', username: 'bob', email: 'bob@example.com' },
        { id: 'user-3', username: 'charlie', email: 'charlie@example.com' },
      ];

      mockPrisma.user.findMany.mockResolvedValue(users);

      await scheduler.runNow();

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        select: {
          id: true,
          username: true,
          email: true,
        },
      });
    });

    it('should handle errors gracefully', async () => {
      const users = [
        { id: 'user-1', username: 'alice' },
        { id: 'user-2', username: 'bob' },
      ];

      mockPrisma.user.findMany.mockResolvedValue(users);

      // Mock StorageTracker to throw error for second user
      const { StorageTracker } = await import('./storageTracker.js');
      const mockTracker = vi.mocked(StorageTracker).mock.results[0].value;

      mockTracker.createDailySnapshot
        .mockResolvedValueOnce('snapshot-1')
        .mockRejectedValueOnce(new Error('Database error'));

      // Should not throw, but log errors
      await expect(scheduler.runNow()).resolves.not.toThrow();
    });

    it('should continue processing if one snapshot fails', async () => {
      const users = [
        { id: 'user-1', username: 'alice' },
        { id: 'user-2', username: 'bob' },
        { id: 'user-3', username: 'charlie' },
      ];

      mockPrisma.user.findMany.mockResolvedValue(users);

      const { StorageTracker } = await import('./storageTracker.js');
      const mockTracker = vi.mocked(StorageTracker).mock.results[0].value;

      mockTracker.createDailySnapshot
        .mockResolvedValueOnce('snapshot-1')
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('snapshot-3');

      await scheduler.runNow();

      // All three users should be attempted
      expect(mockTracker.createDailySnapshot).toHaveBeenCalledTimes(3);
    });
  });

  describe('runNow', () => {
    it('should trigger snapshot creation immediately', async () => {
      const users = [
        { id: 'user-1', username: 'alice' },
      ];

      mockPrisma.user.findMany.mockResolvedValue(users);

      await scheduler.runNow();

      expect(mockPrisma.user.findMany).toHaveBeenCalled();
    });

    it('should work with no users', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);

      await scheduler.runNow();

      expect(mockPrisma.user.findMany).toHaveBeenCalled();
    });
  });

  describe('scheduler timing', () => {
    it('should be configured to run at midnight', () => {
      const cron = require('node-cron').default;

      scheduler.start();

      // Verify cron pattern is for midnight (0 0 * * *)
      expect(cron.schedule).toHaveBeenCalledWith(
        '0 0 * * *',
        expect.any(Function)
      );
    });
  });

  describe('error handling', () => {
    it('should handle database errors when fetching users', async () => {
      mockPrisma.user.findMany.mockRejectedValue(new Error('Database connection failed'));

      await expect(scheduler.runNow()).resolves.not.toThrow();
    });

    it('should log errors but continue operation', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockPrisma.user.findMany.mockRejectedValue(new Error('Test error'));

      await scheduler.runNow();

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
