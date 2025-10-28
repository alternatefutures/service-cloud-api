import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentService } from './deployer.js';
import type { PrismaClient } from '@prisma/client';

// Mock dependencies
vi.mock('../storage/factory.js', () => ({
  StorageServiceFactory: {
    create: vi.fn().mockReturnValue({
      uploadDirectory: vi.fn().mockResolvedValue({
        cid: 'QmTestCID123',
        url: 'https://example.com/QmTestCID123',
        size: 2048,
        storageType: 'IPFS',
      }),
    }),
  },
}));

// Create mock functions using vi.hoisted
const { mockBuild, mockCleanup, MockBuildService } = vi.hoisted(() => {
  const mockBuild = vi.fn();
  const mockCleanup = vi.fn();

  class MockBuildService {
    build = mockBuild;
    cleanup = mockCleanup;
  }

  return { mockBuild, mockCleanup, MockBuildService };
});

vi.mock('../build/builder.js', () => ({
  BuildService: MockBuildService,
}));

vi.mock('../events/index.js', () => ({
  deploymentEvents: {
    emitLog: vi.fn(),
    emitStatus: vi.fn(),
  },
}));

describe('DeploymentService', () => {
  let mockPrisma: any;
  let deploymentService: DeploymentService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockBuild.mockResolvedValue({
      success: true,
      buildPath: '/tmp/build-123',
      logs: ['Build successful'],
    });
    mockCleanup.mockImplementation(() => {});

    mockPrisma = {
      deployment: {
        create: vi.fn().mockResolvedValue({
          id: 'deployment-123',
          siteId: 'site-123',
          cid: '',
          status: 'PENDING',
          storageType: 'IPFS',
        }),
        update: vi.fn().mockResolvedValue({
          id: 'deployment-123',
          status: 'SUCCESS',
          cid: 'QmTestCID123',
        }),
      },
      pin: {
        create: vi.fn().mockResolvedValue({
          id: 'pin-123',
          cid: 'QmTestCID123',
        }),
      },
    };

    deploymentService = new DeploymentService(mockPrisma as unknown as PrismaClient);
  });

  describe('deploy', () => {
    it('should deploy without build options', async () => {
      const result = await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
      });

      expect(result).toEqual({
        deploymentId: 'deployment-123',
        cid: 'QmTestCID123',
        url: 'https://example.com/QmTestCID123',
      });

      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: {
          siteId: 'site-123',
          cid: '',
          status: 'PENDING',
          storageType: 'IPFS',
        },
      });

      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'deployment-123' },
        data: {
          cid: 'QmTestCID123',
          status: 'SUCCESS',
        },
      });

      expect(mockPrisma.pin.create).toHaveBeenCalledWith({
        data: {
          cid: 'QmTestCID123',
          name: 'Site site-123',
          size: 2048,
          deploymentId: 'deployment-123',
        },
      });
    });

    it('should deploy with build options', async () => {
      const result = await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
        buildOptions: {
          buildCommand: 'npm run build',
          installCommand: 'npm install',
        },
      });

      expect(result.deploymentId).toBe('deployment-123');
      expect(result.cid).toBe('QmTestCID123');

      // Should update status to BUILDING
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'deployment-123' },
        data: { status: 'BUILDING' },
      });
    });

    it('should handle build failure', async () => {
      mockBuild.mockResolvedValueOnce({
        success: false,
        buildPath: '/tmp/build-123',
        logs: ['Build failed'],
        error: 'Compilation error',
      });

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
          buildOptions: {
            buildCommand: 'npm run build',
          },
        })
      ).rejects.toThrow('Build failed: Compilation error');

      // Should mark deployment as FAILED
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'deployment-123' },
        data: { status: 'FAILED' },
      });
    });

    it('should call onStatusChange callbacks', async () => {
      const onStatusChange = vi.fn();

      await deploymentService.deploy(
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        },
        { onStatusChange }
      );

      expect(onStatusChange).toHaveBeenCalledWith('UPLOADING');
      expect(onStatusChange).toHaveBeenCalledWith('SUCCESS');
    });

    it('should call onLog callbacks', async () => {
      const onLog = vi.fn();

      await deploymentService.deploy(
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        },
        { onLog }
      );

      expect(onLog).toHaveBeenCalled();
    });

    it('should emit deployment events', async () => {
      const { deploymentEvents } = await import('../events/index.js');

      await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
      });

      expect(deploymentEvents.emitLog).toHaveBeenCalled();
      expect(deploymentEvents.emitStatus).toHaveBeenCalled();
    });

    it('should update status to UPLOADING', async () => {
      await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
      });

      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'deployment-123' },
        data: { status: 'UPLOADING' },
      });
    });

    it('should handle upload errors', async () => {
      const { StorageServiceFactory } = await import('../storage/factory.js');
      const mockStorage = StorageServiceFactory.create('IPFS');
      vi.mocked(mockStorage.uploadDirectory).mockRejectedValueOnce(new Error('Upload failed'));

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        })
      ).rejects.toThrow('Upload failed');

      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'deployment-123' },
        data: { status: 'FAILED' },
      });
    });

    it('should support all storage types', async () => {
      const storageTypes: Array<'IPFS' | 'ARWEAVE' | 'FILECOIN'> = ['IPFS', 'ARWEAVE', 'FILECOIN'];

      for (const storageType of storageTypes) {
        mockPrisma.deployment.create.mockResolvedValueOnce({
          id: `deployment-${storageType}`,
          siteId: 'site-123',
          cid: '',
          status: 'PENDING',
          storageType,
        });

        await deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType,
        });

        expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
          data: {
            siteId: 'site-123',
            cid: '',
            status: 'PENDING',
            storageType,
          },
        });
      }
    });

    it('should use outputDirectory when provided', async () => {
      const { StorageServiceFactory } = await import('../storage/factory.js');
      const mockStorage = StorageServiceFactory.create('IPFS');

      await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
        buildOptions: {
          buildCommand: 'npm run build',
        },
        outputDirectory: 'dist',
      });

      expect(mockStorage.uploadDirectory).toHaveBeenCalledWith('/tmp/build-123/dist');
    });

    it('should cleanup build directory on success', async () => {
      await deploymentService.deploy({
        siteId: 'site-123',
        sourceDirectory: '/tmp/source',
        storageType: 'IPFS',
        buildOptions: {
          buildCommand: 'npm run build',
        },
      });

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('should cleanup build directory on build failure', async () => {
      mockBuild.mockResolvedValueOnce({
        success: false,
        buildPath: '/tmp/build-123',
        logs: [],
        error: 'Build failed',
      });

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
          buildOptions: {
            buildCommand: 'npm run build',
          },
        })
      ).rejects.toThrow();

      expect(mockCleanup).toHaveBeenCalledWith('/tmp/build-123');
    });

    it('should handle build with no buildPath on failure', async () => {
      mockBuild.mockResolvedValueOnce({
        success: false,
        buildPath: '',
        logs: [],
        error: 'Build failed',
      });

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
          buildOptions: {
            buildCommand: 'npm run build',
          },
        })
      ).rejects.toThrow('Build failed');

      // Should not call cleanup if no buildPath
      expect(mockCleanup).not.toHaveBeenCalled();
    });

    it('should emit error logs on failure', async () => {
      const { deploymentEvents } = await import('../events/index.js');
      const { StorageServiceFactory } = await import('../storage/factory.js');
      const mockStorage = StorageServiceFactory.create('IPFS');
      vi.mocked(mockStorage.uploadDirectory).mockRejectedValueOnce(new Error('Upload error'));

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        })
      ).rejects.toThrow();

      expect(deploymentEvents.emitLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('Deployment failed'),
        })
      );
    });

    it('should emit FAILED status on errors', async () => {
      const { deploymentEvents } = await import('../events/index.js');
      const { StorageServiceFactory } = await import('../storage/factory.js');
      const mockStorage = StorageServiceFactory.create('IPFS');
      vi.mocked(mockStorage.uploadDirectory).mockRejectedValueOnce(new Error('Upload error'));

      await expect(
        deploymentService.deploy({
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        })
      ).rejects.toThrow();

      expect(deploymentEvents.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
        })
      );
    });

    it('should handle build logs streaming', async () => {
      const onLog = vi.fn();

      await deploymentService.deploy(
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
          buildOptions: {
            buildCommand: 'npm run build',
          },
        },
        { onLog }
      );

      expect(onLog).toHaveBeenCalledWith(expect.stringContaining('build'));
    });
  });
});
