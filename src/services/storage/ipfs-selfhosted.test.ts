import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfHostedIPFSStorageService } from './ipfs-selfhosted.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
  existsSync: vi.fn().mockReturnValue(true),
}));

// Create mock functions for IPFS client - using vi.hoisted to ensure they're available in the mock
const {
  mockAdd,
  mockAddAll,
  mockPinAdd,
  mockPinRm,
  mockCat,
  mockId,
  mockRepoStat,
  mockGlobSource,
  mockCreate,
} = vi.hoisted(() => {
  const mockAdd = vi.fn();
  const mockPinAdd = vi.fn();
  const mockPinRm = vi.fn();
  const mockCat = vi.fn();
  const mockId = vi.fn();
  const mockRepoStat = vi.fn();
  const mockAddAll = vi.fn();
  const mockGlobSource = vi.fn();

  const mockCreate = vi.fn(() => ({
    add: mockAdd,
    addAll: mockAddAll,
    pin: {
      add: mockPinAdd,
      rm: mockPinRm,
    },
    cat: mockCat,
    id: mockId,
    repo: {
      stat: mockRepoStat,
    },
  }));

  return {
    mockAdd,
    mockAddAll,
    mockPinAdd,
    mockPinRm,
    mockCat,
    mockId,
    mockRepoStat,
    mockGlobSource,
    mockCreate,
  };
});

vi.mock('ipfs-http-client', () => ({
  create: mockCreate,
  globSource: mockGlobSource,
}));

describe('SelfHostedIPFSStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IPFS_API_URL = 'http://localhost:5001';
    process.env.IPFS_GATEWAY_URL = 'https://ipfs.alternatefutures.ai';

    // Reset default mock implementations
    mockAdd.mockResolvedValue({
      cid: {
        toString: () => 'QmTest123',
      },
      size: 1024,
    });

    mockAddAll.mockImplementation(async function* () {
      yield {
        cid: {
          toString: () => 'QmFile1',
        },
        size: 500,
      };
      yield {
        cid: {
          toString: () => 'QmTestDir456',
        },
        size: 2048,
      };
    });

    mockPinAdd.mockResolvedValue(undefined);
    mockPinRm.mockResolvedValue(undefined);

    mockCat.mockImplementation(async function* () {
      yield new Uint8Array([116, 101, 115, 116]); // "test"
    });

    mockId.mockResolvedValue({
      id: 'QmNodeID123',
      agentVersion: 'kubo/0.20.0',
      protocolVersion: 'ipfs/0.1.0',
      addresses: ['/ip4/127.0.0.1/tcp/4001'],
    });

    mockRepoStat.mockResolvedValue({
      numObjects: BigInt(100),
      repoSize: BigInt(1024000),
      storageMax: BigInt(10000000000),
      version: '13',
    });

    mockGlobSource.mockReturnValue([
      { path: 'file1.txt', content: Buffer.from('test1') },
      { path: 'file2.txt', content: Buffer.from('test2') },
    ]);
  });

  describe('Constructor', () => {
    it('should create instance with environment variables', () => {
      const service = new SelfHostedIPFSStorageService();
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService);
      expect(mockCreate).toHaveBeenCalledWith({ url: 'http://localhost:5001' });
    });

    it('should create instance with provided URLs', () => {
      const service = new SelfHostedIPFSStorageService(
        'http://custom:5001',
        'https://custom.gateway.com'
      );
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService);
      expect(mockCreate).toHaveBeenCalledWith({ url: 'http://custom:5001' });
    });

    it('should use default values when env vars are not set', () => {
      delete process.env.IPFS_API_URL;
      delete process.env.IPFS_GATEWAY_URL;

      const service = new SelfHostedIPFSStorageService();
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService);
      expect(mockCreate).toHaveBeenCalledWith({ url: 'http://localhost:5001' });
    });
  });

  describe('upload', () => {
    it('should upload buffer data', async () => {
      const service = new SelfHostedIPFSStorageService();
      const buffer = Buffer.from('test data');

      const result = await service.upload(buffer, 'test.txt');

      expect(mockAdd).toHaveBeenCalledWith(
        {
          path: 'test.txt',
          content: buffer,
        },
        {
          wrapWithDirectory: false,
          pin: true,
        }
      );

      expect(result).toEqual({
        cid: 'QmTest123',
        url: 'https://ipfs.alternatefutures.ai/ipfs/QmTest123',
        size: 1024,
        storageType: 'IPFS',
      });
    });

    it('should upload string data', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.upload('test string data', 'test.txt');

      expect(result).toEqual({
        cid: 'QmTest123',
        url: 'https://ipfs.alternatefutures.ai/ipfs/QmTest123',
        size: 1024,
        storageType: 'IPFS',
      });
    });

    it('should use custom gateway URL', async () => {
      const service = new SelfHostedIPFSStorageService(
        'http://localhost:5001',
        'https://custom.gateway.com'
      );

      const result = await service.upload('test', 'test.txt');

      expect(result.url).toBe('https://custom.gateway.com/ipfs/QmTest123');
    });

    it('should handle upload errors', async () => {
      mockAdd.mockRejectedValueOnce(new Error('Upload failed'));

      const service = new SelfHostedIPFSStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'IPFS upload failed: Upload failed'
      );
    });

    it('should handle unknown errors', async () => {
      mockAdd.mockRejectedValueOnce('Unknown error');

      const service = new SelfHostedIPFSStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'IPFS upload failed: Unknown error'
      );
    });
  });

  describe('uploadDirectory', () => {
    it('should upload directory', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.uploadDirectory('/tmp/test-dir');

      expect(result).toEqual({
        cid: 'QmTestDir456',
        url: 'https://ipfs.alternatefutures.ai/ipfs/QmTestDir456',
        size: 2048,
        storageType: 'IPFS',
      });
    });

    it('should throw error when directory does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);

      const service = new SelfHostedIPFSStorageService();

      await expect(service.uploadDirectory('/non-existent-dir')).rejects.toThrow(
        'Directory not found: /non-existent-dir'
      );
    });

    it('should throw error when no files uploaded', async () => {
      mockAddAll.mockImplementation(async function* () {
        // Empty generator - no files
      });

      const service = new SelfHostedIPFSStorageService();

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow('No files uploaded');
    });

    it('should handle directory upload errors', async () => {
      mockAddAll.mockImplementation(async function* () {
        throw new Error('Directory upload failed');
      });

      const service = new SelfHostedIPFSStorageService();

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'IPFS directory upload failed: Directory upload failed'
      );
    });

    it('should handle unknown directory upload errors', async () => {
      mockAddAll.mockImplementation(async function* () {
        throw 'Unknown error';
      });

      const service = new SelfHostedIPFSStorageService();

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'IPFS directory upload failed: Unknown error'
      );
    });
  });

  describe('pin', () => {
    it('should pin a CID', async () => {
      const service = new SelfHostedIPFSStorageService();

      await service.pin('QmTest123');

      expect(mockPinAdd).toHaveBeenCalledWith('QmTest123');
    });

    it('should handle pin errors', async () => {
      mockPinAdd.mockRejectedValueOnce(new Error('Pin failed'));

      const service = new SelfHostedIPFSStorageService();

      await expect(service.pin('QmTest123')).rejects.toThrow('IPFS pin failed: Pin failed');
    });

    it('should handle unknown pin errors', async () => {
      mockPinAdd.mockRejectedValueOnce('Unknown error');

      const service = new SelfHostedIPFSStorageService();

      await expect(service.pin('QmTest123')).rejects.toThrow('IPFS pin failed: Unknown error');
    });
  });

  describe('unpin', () => {
    it('should unpin a CID', async () => {
      const service = new SelfHostedIPFSStorageService();

      await service.unpin('QmTest123');

      expect(mockPinRm).toHaveBeenCalledWith('QmTest123');
    });

    it('should handle unpin errors', async () => {
      mockPinRm.mockRejectedValueOnce(new Error('Unpin failed'));

      const service = new SelfHostedIPFSStorageService();

      await expect(service.unpin('QmTest123')).rejects.toThrow('IPFS unpin failed: Unpin failed');
    });

    it('should handle unknown unpin errors', async () => {
      mockPinRm.mockRejectedValueOnce('Unknown error');

      const service = new SelfHostedIPFSStorageService();

      await expect(service.unpin('QmTest123')).rejects.toThrow('IPFS unpin failed: Unknown error');
    });
  });

  describe('get', () => {
    it('should retrieve file from IPFS', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.get('QmTest123');

      expect(mockCat).toHaveBeenCalledWith('QmTest123');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('test');
    });

    it('should handle multiple chunks', async () => {
      mockCat.mockImplementation(async function* () {
        yield new Uint8Array([116, 101, 115, 116]); // "test"
        yield new Uint8Array([32, 100, 97, 116, 97]); // " data"
      });

      const service = new SelfHostedIPFSStorageService();

      const result = await service.get('QmTest123');

      expect(result.toString()).toBe('test data');
    });

    it('should handle get errors', async () => {
      mockCat.mockImplementation(async function* () {
        throw new Error('Get failed');
      });

      const service = new SelfHostedIPFSStorageService();

      await expect(service.get('QmTest123')).rejects.toThrow('IPFS get failed: Get failed');
    });

    it('should handle unknown get errors', async () => {
      mockCat.mockImplementation(async function* () {
        throw 'Unknown error';
      });

      const service = new SelfHostedIPFSStorageService();

      await expect(service.get('QmTest123')).rejects.toThrow('IPFS get failed: Unknown error');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection succeeds', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.testConnection();

      expect(mockId).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false when connection fails', async () => {
      mockId.mockRejectedValueOnce(new Error('Connection failed'));

      const service = new SelfHostedIPFSStorageService();

      const result = await service.testConnection();

      expect(result).toBe(false);
    });
  });

  describe('getNodeInfo', () => {
    it('should return node information', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.getNodeInfo();

      expect(mockId).toHaveBeenCalled();
      expect(result).toEqual({
        id: 'QmNodeID123',
        agentVersion: 'kubo/0.20.0',
        protocolVersion: 'ipfs/0.1.0',
        addresses: ['/ip4/127.0.0.1/tcp/4001'],
      });
    });

    it('should handle node info errors', async () => {
      mockId.mockRejectedValueOnce(new Error('Failed to get node info'));

      const service = new SelfHostedIPFSStorageService();

      await expect(service.getNodeInfo()).rejects.toThrow('Failed to get node info');
    });
  });

  describe('getStats', () => {
    it('should return repository statistics', async () => {
      const service = new SelfHostedIPFSStorageService();

      const result = await service.getStats();

      expect(mockRepoStat).toHaveBeenCalled();
      expect(result).toEqual({
        numObjects: BigInt(100),
        repoSize: BigInt(1024000),
        storageMax: BigInt(10000000000),
        version: '13',
      });
    });

    it('should handle stats errors', async () => {
      mockRepoStat.mockRejectedValueOnce(new Error('Failed to get stats'));

      const service = new SelfHostedIPFSStorageService();

      await expect(service.getStats()).rejects.toThrow('Failed to get stats');
    });
  });
});
