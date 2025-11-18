import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvers } from './index.js'
import type { Context } from './index.js'
import { GraphQLError } from 'graphql'

describe('Storage Analytics Resolvers', () => {
  let mockContext: Context

  beforeEach(() => {
    mockContext = {
      prisma: {
        site: {
          findMany: vi.fn(),
        },
      } as any,
      userId: 'user-123',
      projectId: 'project-123',
    } as Context
  })

  describe('storageAnalytics', () => {
    it('should throw error if no project ID is provided', async () => {
      const contextWithoutProject = {
        ...mockContext,
        projectId: undefined,
      }

      await expect(
        resolvers.Query.storageAnalytics({}, {}, contextWithoutProject)
      ).rejects.toThrow(GraphQLError)
    })

    it('should calculate total storage analytics correctly', async () => {
      const mockSites = [
        {
          id: 'site-1',
          name: 'Site 1',
          projectId: 'project-123',
          deployments: [
            {
              id: 'dep-1',
              cid: 'cid-1',
              storageType: 'IPFS',
              createdAt: new Date('2024-01-01'),
              pin: { size: 1000 },
            },
            {
              id: 'dep-2',
              cid: 'cid-2',
              storageType: 'IPFS',
              createdAt: new Date('2024-01-02'),
              pin: { size: 2000 },
            },
          ],
        },
        {
          id: 'site-2',
          name: 'Site 2',
          projectId: 'project-123',
          deployments: [
            {
              id: 'dep-3',
              cid: 'cid-3',
              storageType: 'ARWEAVE',
              createdAt: new Date('2024-01-03'),
              pin: { size: 3000 },
            },
          ],
        },
      ]

      ;(mockContext.prisma.site.findMany as any).mockResolvedValue(mockSites)

      const result = await resolvers.Query.storageAnalytics(
        {},
        { projectId: 'project-123' },
        mockContext
      )

      expect(result).toEqual({
        totalSize: 6000,
        ipfsSize: 3000,
        arweaveSize: 3000,
        deploymentCount: 3,
        siteCount: 2,
        breakdown: [
          {
            id: 'site-1',
            name: 'Site 1',
            type: 'SITE',
            size: 3000,
            deploymentCount: 2,
            storageType: 'IPFS',
            lastDeployment: new Date('2024-01-02'),
          },
          {
            id: 'site-2',
            name: 'Site 2',
            type: 'SITE',
            size: 3000,
            deploymentCount: 1,
            storageType: 'ARWEAVE',
            lastDeployment: new Date('2024-01-03'),
          },
        ],
      })
    })

    it('should handle sites with no deployments', async () => {
      const mockSites = [
        {
          id: 'site-1',
          name: 'Site 1',
          projectId: 'project-123',
          deployments: [],
        },
      ]

      ;(mockContext.prisma.site.findMany as any).mockResolvedValue(mockSites)

      const result = await resolvers.Query.storageAnalytics(
        {},
        { projectId: 'project-123' },
        mockContext
      )

      expect(result).toEqual({
        totalSize: 0,
        ipfsSize: 0,
        arweaveSize: 0,
        deploymentCount: 0,
        siteCount: 1,
        breakdown: [],
      })
    })

    it('should handle missing pin sizes', async () => {
      const mockSites = [
        {
          id: 'site-1',
          name: 'Site 1',
          projectId: 'project-123',
          deployments: [
            {
              id: 'dep-1',
              cid: 'cid-1',
              storageType: 'IPFS',
              createdAt: new Date('2024-01-01'),
              pin: null,
            },
          ],
        },
      ]

      ;(mockContext.prisma.site.findMany as any).mockResolvedValue(mockSites)

      const result = await resolvers.Query.storageAnalytics(
        {},
        { projectId: 'project-123' },
        mockContext
      )

      expect(result.totalSize).toBe(0)
      expect(result.deploymentCount).toBe(1)
    })
  })

  describe('storageUsageTrend', () => {
    it('should throw error if no project ID is provided', async () => {
      const contextWithoutProject = {
        ...mockContext,
        projectId: undefined,
      }

      await expect(
        resolvers.Query.storageUsageTrend({}, {}, contextWithoutProject)
      ).rejects.toThrow(GraphQLError)
    })

    it('should calculate usage trend correctly', async () => {
      const mockSites = [
        {
          id: 'site-1',
          name: 'Site 1',
          deployments: [
            {
              id: 'dep-1',
              createdAt: new Date('2024-01-01'),
              pin: { size: 1000 },
            },
            {
              id: 'dep-2',
              createdAt: new Date('2024-01-01'),
              pin: { size: 500 },
            },
            {
              id: 'dep-3',
              createdAt: new Date('2024-01-02'),
              pin: { size: 2000 },
            },
          ],
        },
      ]

      ;(mockContext.prisma.site.findMany as any).mockResolvedValue(mockSites)

      const result = await resolvers.Query.storageUsageTrend(
        {},
        { projectId: 'project-123', days: 30 },
        mockContext
      )

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        date: new Date('2024-01-01'),
        totalSize: 1500,
        deploymentCount: 2,
      })
      expect(result[1]).toEqual({
        date: new Date('2024-01-02'),
        totalSize: 3500,
        deploymentCount: 1,
      })
    })

    it('should filter deployments by date range', async () => {
      const recentDate = new Date()
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 40)

      const mockSites = [
        {
          id: 'site-1',
          name: 'Site 1',
          deployments: [], // Will be filtered by the query where clause
        },
      ]

      ;(mockContext.prisma.site.findMany as any).mockResolvedValue(mockSites)

      await resolvers.Query.storageUsageTrend(
        {},
        { projectId: 'project-123', days: 30 },
        mockContext
      )

      // Verify that findMany was called with the correct date filter
      expect(mockContext.prisma.site.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: 'project-123' },
          include: expect.objectContaining({
            deployments: expect.objectContaining({
              where: expect.objectContaining({
                createdAt: expect.objectContaining({
                  gte: expect.any(Date),
                }),
              }),
            }),
          }),
        })
      )
    })
  })
})
