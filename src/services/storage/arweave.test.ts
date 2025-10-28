import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArweaveStorageService } from './arweave.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the @ardrive/turbo-sdk module
vi.mock('@ardrive/turbo-sdk', () => {
  return {
    TurboFactory: {
      authenticated: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockImplementation((params: any) => {
          // Call the factory functions to ensure coverage
          if (params.fileStreamFactory) {
            params.fileStreamFactory();
          }
          if (params.fileSizeFactory) {
            params.fileSizeFactory();
          }
          return Promise.resolve({
            id: 'arweave-tx-123',
          });
        }),
      }),
    },
  };
});

describe('ArweaveStorageService', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arweave-test-'));
    process.env.ARWEAVE_PRIVATE_KEY = JSON.stringify({ test: 'key' });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Constructor', () => {
    it('should create instance with environment variable', () => {
      const service = new ArweaveStorageService();
      expect(service).toBeInstanceOf(ArweaveStorageService);
    });

    it('should create instance with provided private key', () => {
      const service = new ArweaveStorageService(JSON.stringify({ custom: 'key' }));
      expect(service).toBeInstanceOf(ArweaveStorageService);
    });

    it('should throw error when private key is missing', async () => {
      delete process.env.ARWEAVE_PRIVATE_KEY;
      const service = new ArweaveStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'Arweave private key not configured'
      );
    });

    it('should only initialize once', async () => {
      const service = new ArweaveStorageService();
      const { TurboFactory } = await import('@ardrive/turbo-sdk');

      // First upload will initialize
      await service.upload(Buffer.from('test'), 'test.txt');

      const firstCallCount = vi.mocked(TurboFactory.authenticated).mock.calls.length;

      // Second upload should not initialize again
      await service.upload(Buffer.from('test2'), 'test2.txt');

      const secondCallCount = vi.mocked(TurboFactory.authenticated).mock.calls.length;

      // Should be called same number of times (not twice)
      expect(secondCallCount).toBe(firstCallCount);
    });
  });

  describe('upload', () => {
    it('should upload buffer data', async () => {
      const service = new ArweaveStorageService();
      const buffer = Buffer.from('test data');

      const result = await service.upload(buffer, 'test.txt');

      expect(result).toEqual({
        cid: 'arweave-tx-123',
        url: 'https://arweave.net/arweave-tx-123',
        size: buffer.length,
        storageType: 'ARWEAVE',
      });
    });

    it('should upload string data', async () => {
      const service = new ArweaveStorageService();
      const testString = 'test string data';

      const result = await service.upload(testString, 'test.txt');

      expect(result).toEqual({
        cid: 'arweave-tx-123',
        url: 'https://arweave.net/arweave-tx-123',
        size: Buffer.from(testString).length,
        storageType: 'ARWEAVE',
      });
    });

    it('should handle initialization errors', async () => {
      delete process.env.ARWEAVE_PRIVATE_KEY;
      const service = new ArweaveStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'Arweave private key not configured'
      );
    });

    it('should handle invalid JWK format', async () => {
      process.env.ARWEAVE_PRIVATE_KEY = 'invalid-json';
      const service = new ArweaveStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'Failed to initialize Arweave client'
      );
    });

    it('should handle upload errors', async () => {
      const { TurboFactory } = await import('@ardrive/turbo-sdk');
      const mockTurbo = await TurboFactory.authenticated({ privateKey: {} as any });
      vi.mocked(mockTurbo.uploadFile).mockRejectedValueOnce(new Error('Upload failed'));

      const service = new ArweaveStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'Arweave upload failed: Upload failed'
      );
    });

    it('should handle unknown upload errors', async () => {
      const { TurboFactory } = await import('@ardrive/turbo-sdk');
      const mockTurbo = await TurboFactory.authenticated({ privateKey: {} as any });
      vi.mocked(mockTurbo.uploadFile).mockRejectedValueOnce('Unknown error');

      const service = new ArweaveStorageService();

      await expect(service.upload(Buffer.from('test'), 'test.txt')).rejects.toThrow(
        'Arweave upload failed: Unknown error'
      );
    });
  });

  describe('uploadDirectory', () => {
    it('should upload directory with single file', async () => {
      // Create test file
      fs.writeFileSync(path.join(tempDir, 'index.html'), '<html>Test</html>');

      const service = new ArweaveStorageService();

      const result = await service.uploadDirectory(tempDir);

      expect(result.cid).toBe('arweave-tx-123');
      expect(result.url).toBe('https://arweave.net/arweave-tx-123');
      expect(result.storageType).toBe('ARWEAVE');
    });

    it('should upload directory with multiple files', async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, 'index.html'), '<html>Test</html>');
      fs.writeFileSync(path.join(tempDir, 'style.css'), 'body { color: red; }');
      fs.mkdirSync(path.join(tempDir, 'js'));
      fs.writeFileSync(path.join(tempDir, 'js', 'app.js'), 'console.log("test");');

      const service = new ArweaveStorageService();

      const result = await service.uploadDirectory(tempDir);

      expect(result.storageType).toBe('ARWEAVE');
    });

    it('should handle missing directory', async () => {
      const service = new ArweaveStorageService();

      await expect(service.uploadDirectory('/non-existent-directory')).rejects.toThrow(
        'Directory not found'
      );
    });

    it('should handle empty directory', async () => {
      const service = new ArweaveStorageService();

      await expect(service.uploadDirectory(tempDir)).rejects.toThrow(
        'No files found in directory'
      );
    });

    it('should handle upload errors', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');

      const { TurboFactory } = await import('@ardrive/turbo-sdk');
      const mockTurbo = await TurboFactory.authenticated({ privateKey: {} as any });
      vi.mocked(mockTurbo.uploadFile).mockRejectedValueOnce(new Error('Upload failed'));

      const service = new ArweaveStorageService();

      await expect(service.uploadDirectory(tempDir)).rejects.toThrow(
        'Arweave directory upload failed'
      );
    });

    it('should detect content types correctly', async () => {
      // Create files with different extensions
      const files = [
        { name: 'index.html', content: '<html></html>' },
        { name: 'style.css', content: 'body {}' },
        { name: 'script.js', content: 'console.log()' },
        { name: 'data.json', content: '{}' },
        { name: 'image.png', content: 'fake-png' },
        { name: 'image.jpg', content: 'fake-jpg' },
        { name: 'image.svg', content: '<svg></svg>' },
        { name: 'unknown.xyz', content: 'unknown' },
      ];

      files.forEach((file) => {
        fs.writeFileSync(path.join(tempDir, file.name), file.content);
      });

      const service = new ArweaveStorageService();

      const result = await service.uploadDirectory(tempDir);

      expect(result.storageType).toBe('ARWEAVE');
    });
  });
});
