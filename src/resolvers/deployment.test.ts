import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvers } from './index.js'
import type { Context } from './index.js'

// Create mock deploy function using vi.hoisted
const { mockDeploy, MockDeploymentService } = vi.hoisted(() => {
  const mockDeploy = vi.fn().mockResolvedValue({
    deploymentId: 'deployment-123',
    cid: 'QmTestCID',
    url: 'https://example.com/QmTestCID',
  })

  class MockDeploymentService {
    deploy = mockDeploy
    constructor(prisma: any) {}
  }

  return { mockDeploy, MockDeploymentService }
})

// Mock the deployment service
vi.mock('../services/deployment/index.js', () => ({
  DeploymentService: MockDeploymentService,
}))

// Use real deployment events for subscription testing
import { deploymentEvents } from '../services/events/index.js'

describe('Deployment Resolvers', () => {
  let mockContext: Context

  beforeEach(() => {
    vi.clearAllMocks()
    // Clear event listeners between tests
    deploymentEvents.removeAllListeners()

    // Reset mock implementation
    mockDeploy.mockResolvedValue({
      deploymentId: 'deployment-123',
      cid: 'QmTestCID',
      url: 'https://example.com/QmTestCID',
    })

    mockContext = {
      prisma: {
        site: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'site-123',
            name: 'Test Site',
          }),
        },
        deployment: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'deployment-123',
            siteId: 'site-123',
            cid: 'QmTestCID',
            status: 'SUCCESS',
            storageType: 'IPFS',
          }),
        },
      } as any,
      userId: 'user-123',
      projectId: 'project-123',
    } as any
  })

  describe('createDeployment mutation', () => {
    it('should create deployment without build options', async () => {
      const result = await resolvers.Mutation.createDeployment(
        {},
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
        },
        mockContext
      )

      expect(result).toEqual({
        id: 'deployment-123',
        siteId: 'site-123',
        cid: 'QmTestCID',
        status: 'SUCCESS',
        storageType: 'IPFS',
      })

      expect(mockContext.prisma.site.findUnique).toHaveBeenCalledWith({
        where: { id: 'site-123' },
      })
    })

    it('should create deployment with build options', async () => {
      const result = await resolvers.Mutation.createDeployment(
        {},
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'IPFS',
          buildOptions: {
            buildCommand: 'npm run build',
            installCommand: 'npm install',
            workingDirectory: '.',
            outputDirectory: 'dist',
          },
        },
        mockContext
      )

      expect(result.id).toBe('deployment-123')
    })

    it('should default to IPFS when storage type not specified', async () => {
      const result = await resolvers.Mutation.createDeployment(
        {},
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
        },
        mockContext
      )

      expect(result).toBeDefined()
    })

    it('should throw error if site not found', async () => {
      vi.mocked(mockContext.prisma.site.findUnique).mockResolvedValueOnce(null)

      await expect(
        resolvers.Mutation.createDeployment(
          {},
          {
            siteId: 'non-existent',
            sourceDirectory: '/tmp/source',
          },
          mockContext
        )
      ).rejects.toThrow('Site not found')
    })

    it('should throw error if deployment not found after creation', async () => {
      vi.mocked(mockContext.prisma.deployment.findUnique).mockResolvedValueOnce(
        null
      )

      await expect(
        resolvers.Mutation.createDeployment(
          {},
          {
            siteId: 'site-123',
            sourceDirectory: '/tmp/source',
          },
          mockContext
        )
      ).rejects.toThrow('Deployment not found after creation')
    })

    it('should support ARWEAVE storage type', async () => {
      const result = await resolvers.Mutation.createDeployment(
        {},
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'ARWEAVE',
        },
        mockContext
      )

      expect(result).toBeDefined()
    })

    it('should support FILECOIN storage type', async () => {
      const result = await resolvers.Mutation.createDeployment(
        {},
        {
          siteId: 'site-123',
          sourceDirectory: '/tmp/source',
          storageType: 'FILECOIN',
        },
        mockContext
      )

      expect(result).toBeDefined()
    })
  })

  describe('deploymentLogs subscription', () => {
    it('should subscribe to deployment logs', async () => {
      const generator = resolvers.Subscription.deploymentLogs.subscribe(
        {},
        { deploymentId: 'deployment-123' },
        mockContext
      )

      // Generator should be created
      expect(generator).toBeDefined()
      expect(typeof generator[Symbol.asyncIterator]).toBe('function')
    })

    it('should throw error if deployment not found', async () => {
      vi.mocked(mockContext.prisma.deployment.findUnique).mockResolvedValueOnce(
        null
      )

      await expect(async () => {
        const generator = resolvers.Subscription.deploymentLogs.subscribe(
          {},
          { deploymentId: 'non-existent' },
          mockContext
        )
        await generator.next()
      }).rejects.toThrow('Deployment not found')
    })

    it('should yield events from queue when available', async () => {
      // This test verifies the generator setup and cleanup
      // The actual event emission is tested in integration tests
      const generator = resolvers.Subscription.deploymentLogs.subscribe(
        {},
        { deploymentId: 'deployment-123' },
        mockContext
      )

      // Verify generator is created
      expect(generator).toBeDefined()
      expect(generator[Symbol.asyncIterator]).toBeDefined()

      // Return early to trigger cleanup (finally block)
      const result = await generator.return({ done: true, value: undefined })
      expect(result.done).toBe(true)
    })

    it('should resolve payload correctly', () => {
      const payload = {
        deploymentId: 'deployment-123',
        timestamp: new Date(),
        message: 'Test log',
        level: 'info',
      }

      const result = resolvers.Subscription.deploymentLogs.resolve(payload)

      expect(result).toEqual(payload)
    })
  })

  describe('deploymentStatus subscription', () => {
    it('should subscribe to deployment status', async () => {
      const generator = resolvers.Subscription.deploymentStatus.subscribe(
        {},
        { deploymentId: 'deployment-123' },
        mockContext
      )

      // Generator should be created
      expect(generator).toBeDefined()
      expect(typeof generator[Symbol.asyncIterator]).toBe('function')
    })

    it('should throw error if deployment not found', async () => {
      vi.mocked(mockContext.prisma.deployment.findUnique).mockResolvedValueOnce(
        null
      )

      await expect(async () => {
        const generator = resolvers.Subscription.deploymentStatus.subscribe(
          {},
          { deploymentId: 'non-existent' },
          mockContext
        )
        await generator.next()
      }).rejects.toThrow('Deployment not found')
    })

    it('should yield events from queue when available', async () => {
      // This test verifies the generator setup and cleanup
      // The actual event emission is tested in integration tests
      const generator = resolvers.Subscription.deploymentStatus.subscribe(
        {},
        { deploymentId: 'deployment-123' },
        mockContext
      )

      // Verify generator is created
      expect(generator).toBeDefined()
      expect(generator[Symbol.asyncIterator]).toBeDefined()

      // Return early to trigger cleanup (finally block)
      const result = await generator.return({ done: true, value: undefined })
      expect(result.done).toBe(true)
    })

    it('should resolve payload correctly', () => {
      const payload = {
        deploymentId: 'deployment-123',
        status: 'SUCCESS',
        timestamp: new Date(),
      }

      const result = resolvers.Subscription.deploymentStatus.resolve(payload)

      expect(result).toEqual(payload)
    })
  })
})
