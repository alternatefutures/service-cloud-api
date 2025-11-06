import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPFSWithTracking } from './ipfsWithTracking.js';
import type { PrismaClient } from '@prisma/client';
import type { UploadResult } from './types.js';

// Mock IPFS storage service
vi.mock('./ipfs.js', () => ({
  IPFSStorageService: class {
    upload = vi.fn();
    uploadDirectory = vi.fn();
  },
}));

// Mock StorageTracker
vi.mock('../billing/storageTracker.js', () => ({
  StorageTracker: class {
    trackPinEvent = vi.fn().mockResolvedValue('pin-123');
    trackUnpinEvent = vi.fn().mockResolvedValue(true);
    getCurrentStorage = vi.fn().mockResolvedValue(BigInt(1024 * 1024 * 500));
    getActivePins = vi.fn().mockResolvedValue([]);
    constructor(prisma: any) {}
  },
}));

describe('IPFSWithTracking', () => {
  let ipfsService: IPFSWithTracking;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {} as any;

    ipfsService = new IPFSWithTracking(mockPrisma as PrismaClient, 'api-key', 'api-secret');
  });

  describe('uploadWithTracking', () => {
    it('should upload file and track pin event', async () => {
      const uploadResult: UploadResult = {
        cid: 'QmTest123',
        size: 1024 * 1024 * 50, // 50 MB
      };

      const mockUpload = ipfsService['upload'] as any;
      mockUpload.mockResolvedValue(uploadResult);

      const result = await ipfsService.uploadWithTracking(
        Buffer.from('test data'),
        'test.jpg',
        'user-123',
        'image/jpeg'
      );

      expect(result).toEqual(uploadResult);
      expect(mockUpload).toHaveBeenCalledWith(Buffer.from('test data'), 'test.jpg');

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackPinEvent).toHaveBeenCalledWith(
        'user-123',
        'QmTest123',
        1024 * 1024 * 50,
        'test.jpg',
        'image/jpeg'
      );
    });

    it('should track pin without mimeType', async () => {
      const uploadResult: UploadResult = {
        cid: 'QmTest456',
        size: 1024 * 1024 * 25,
      };

      const mockUpload = ipfsService['upload'] as any;
      mockUpload.mockResolvedValue(uploadResult);

      await ipfsService.uploadWithTracking(
        'string data',
        'test.txt',
        'user-456'
      );

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackPinEvent).toHaveBeenCalledWith(
        'user-456',
        'QmTest456',
        1024 * 1024 * 25,
        'test.txt',
        undefined
      );
    });

    it('should throw error if upload fails', async () => {
      const mockUpload = ipfsService['upload'] as any;
      mockUpload.mockRejectedValue(new Error('IPFS upload failed'));

      await expect(
        ipfsService.uploadWithTracking(
          Buffer.from('test'),
          'test.jpg',
          'user-123'
        )
      ).rejects.toThrow('IPFS upload failed');

      const mockTracker = ipfsService['storageTracker'];

      // Tracking should not be called if upload fails
      expect(mockTracker.trackPinEvent).not.toHaveBeenCalled();
    });
  });

  describe('uploadDirectoryWithTracking', () => {
    it('should upload directory and track pin event', async () => {
      const uploadResult: UploadResult = {
        cid: 'QmDirTest',
        size: 1024 * 1024 * 100, // 100 MB
      };

      const mockUploadDir = ipfsService['uploadDirectory'] as any;
      mockUploadDir.mockResolvedValue(uploadResult);

      const result = await ipfsService.uploadDirectoryWithTracking(
        '/path/to/dir',
        'user-789'
      );

      expect(result).toEqual(uploadResult);
      expect(mockUploadDir).toHaveBeenCalledWith('/path/to/dir');

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackPinEvent).toHaveBeenCalledWith(
        'user-789',
        'QmDirTest',
        1024 * 1024 * 100,
        '/path/to/dir'
      );
    });

    it('should throw error if directory upload fails', async () => {
      const mockUploadDir = ipfsService['uploadDirectory'] as any;
      mockUploadDir.mockRejectedValue(new Error('Directory not found'));

      await expect(
        ipfsService.uploadDirectoryWithTracking('/bad/path', 'user-789')
      ).rejects.toThrow('Directory not found');

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackPinEvent).not.toHaveBeenCalled();
    });
  });

  describe('unpinWithTracking', () => {
    it('should track unpin event', async () => {
      const result = await ipfsService.unpinWithTracking('QmTest123', 'user-123');

      expect(result).toBe(true);

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackUnpinEvent).toHaveBeenCalledWith('user-123', 'QmTest123');
    });

    it('should throw error if unpin tracking fails', async () => {
      const mockTracker = ipfsService['storageTracker'];

      mockTracker.trackUnpinEvent.mockRejectedValue(new Error('Database error'));

      await expect(
        ipfsService.unpinWithTracking('QmTest123', 'user-123')
      ).rejects.toThrow('IPFS unpin failed: Database error');
    });
  });

  describe('getCurrentStorage', () => {
    it('should return current storage for user', async () => {
      const result = await ipfsService.getCurrentStorage('user-123');

      expect(result).toBe(BigInt(1024 * 1024 * 500)); // 500 MB

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.getCurrentStorage).toHaveBeenCalledWith('user-123');
    });
  });

  describe('getActivePins', () => {
    it('should return active pins for user with default limit', async () => {
      const mockPins = [
        {
          id: 'pin-1',
          cid: 'QmTest1',
          sizeBytes: BigInt(1024 * 1024 * 25),
          filename: 'file1.jpg',
        },
        {
          id: 'pin-2',
          cid: 'QmTest2',
          sizeBytes: BigInt(1024 * 1024 * 30),
          filename: 'file2.png',
        },
      ];

      const mockTracker = ipfsService['storageTracker'];

      mockTracker.getActivePins.mockResolvedValue(mockPins);

      const result = await ipfsService.getActivePins('user-123');

      expect(result).toEqual(mockPins);
      expect(mockTracker.getActivePins).toHaveBeenCalledWith('user-123', undefined);
    });

    it('should return active pins with custom limit', async () => {
      const mockTracker = ipfsService['storageTracker'];

      await ipfsService.getActivePins('user-123', 50);

      expect(mockTracker.getActivePins).toHaveBeenCalledWith('user-123', 50);
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete upload and unpin cycle', async () => {
      // Upload
      const uploadResult: UploadResult = {
        cid: 'QmCycle123',
        size: 1024 * 1024 * 75,
      };

      const mockUpload = ipfsService['upload'] as any;
      mockUpload.mockResolvedValue(uploadResult);

      const mockTracker = ipfsService['storageTracker'];

      await ipfsService.uploadWithTracking(
        Buffer.from('cycle test'),
        'cycle.jpg',
        'user-cycle'
      );

      expect(mockTracker.trackPinEvent).toHaveBeenCalledWith(
        'user-cycle',
        'QmCycle123',
        1024 * 1024 * 75,
        'cycle.jpg',
        undefined
      );

      // Unpin
      await ipfsService.unpinWithTracking('QmCycle123', 'user-cycle');

      expect(mockTracker.trackUnpinEvent).toHaveBeenCalledWith('user-cycle', 'QmCycle123');
    });

    it('should track large file upload', async () => {
      const largeFileSize = 1024 * 1024 * 1024 * 5; // 5 GB

      const uploadResult: UploadResult = {
        cid: 'QmLargeFile',
        size: largeFileSize,
      };

      const mockUpload = ipfsService['upload'] as any;
      mockUpload.mockResolvedValue(uploadResult);

      // Use a small buffer since upload is mocked - we're just testing the tracking
      await ipfsService.uploadWithTracking(
        Buffer.alloc(1024), // Small buffer, actual size comes from uploadResult
        'large.iso',
        'user-large',
        'application/octet-stream'
      );

      const mockTracker = ipfsService['storageTracker'];

      expect(mockTracker.trackPinEvent).toHaveBeenCalledWith(
        'user-large',
        'QmLargeFile',
        largeFileSize,
        'large.iso',
        'application/octet-stream'
      );
    });
  });
});
