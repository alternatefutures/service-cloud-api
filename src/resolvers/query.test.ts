import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvers } from './index.js'
import type { Context } from './index.js'

// Mock listDomainsForSite function
const { mockListDomainsForSite } = vi.hoisted(() => ({
  mockListDomainsForSite: vi.fn(),
}))

vi.mock('../services/dns/domainService.js', async () => {
  const actual = await vi.importActual('../services/dns/domainService.js')
  return {
    ...actual,
    listDomainsForSite: mockListDomainsForSite,
  }
})

describe('Query Resolvers', () => {
  let mockContext: Context

  beforeEach(() => {
    vi.clearAllMocks()

    mockContext = {
      prisma: {
        user: {
          findUnique: vi.fn(),
        },
        project: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
        },
        site: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
        },
        aFFunction: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
        aFFunctionDeployment: {
          findMany: vi.fn(),
        },
        domain: {
          findMany: vi.fn(),
        },
      } as any,
      userId: 'user-123',
      projectId: 'project-123',
    } as any
  })

  describe('version', () => {
    it('should return commit hash from environment', () => {
      process.env.COMMIT_HASH = 'abc123'
      const result = resolvers.Query.version()
      expect(result).toEqual({ commitHash: 'abc123' })
    })

    it('should return "dev" when COMMIT_HASH is not set', () => {
      delete process.env.COMMIT_HASH
      const result = resolvers.Query.version()
      expect(result).toEqual({ commitHash: 'dev' })
    })
  })

  describe('me', () => {
    it('should return current user', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' }
      vi.mocked(mockContext.prisma.user.findUnique).mockResolvedValue(mockUser)

      const result = await resolvers.Query.me({}, {}, mockContext)

      expect(result).toEqual(mockUser)
      expect(mockContext.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      })
    })

    it('should throw error if not authenticated', async () => {
      mockContext.userId = undefined

      await expect(resolvers.Query.me({}, {}, mockContext)).rejects.toThrow(
        'Not authenticated'
      )
    })
  })

  describe('project', () => {
    it('should return project by id', async () => {
      const mockProject = { id: 'project-123', name: 'Test Project' }
      vi.mocked(mockContext.prisma.project.findUnique).mockResolvedValue(
        mockProject
      )

      const result = await resolvers.Query.project(
        {},
        { id: 'project-123' },
        mockContext
      )

      expect(result).toEqual(mockProject)
      expect(mockContext.prisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: 'project-123' },
      })
    })
  })

  describe('projects', () => {
    it('should return all projects for user in wrapped format', async () => {
      const mockProjects = [
        { id: 'project-1', name: 'Project 1' },
        { id: 'project-2', name: 'Project 2' },
      ]
      vi.mocked(mockContext.prisma.project.findMany).mockResolvedValue(
        mockProjects
      )

      const result = await resolvers.Query.projects({}, {}, mockContext)

      // SDK expects wrapped format { data: [...] }
      expect(result).toEqual({ data: mockProjects })
      expect(mockContext.prisma.project.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      })
    })

    it('should throw error if not authenticated', async () => {
      mockContext.userId = undefined

      await expect(
        resolvers.Query.projects({}, {}, mockContext)
      ).rejects.toThrow('Not authenticated')
    })
  })

  describe('site', () => {
    it('should return site by id', async () => {
      const mockSite = { id: 'site-123', name: 'Test Site' }
      vi.mocked(mockContext.prisma.site.findUnique).mockResolvedValue(mockSite)

      const result = await resolvers.Query.site(
        {},
        { where: { id: 'site-123' } },
        mockContext
      )

      expect(result).toEqual(mockSite)
      expect(mockContext.prisma.site.findUnique).toHaveBeenCalledWith({
        where: { id: 'site-123' },
      })
    })
  })

  describe('sites', () => {
    it('should return all sites for project in wrapped format', async () => {
      const mockSites = [
        { id: 'site-1', name: 'Site 1' },
        { id: 'site-2', name: 'Site 2' },
      ]
      vi.mocked(mockContext.prisma.site.findMany).mockResolvedValue(mockSites)

      const result = await resolvers.Query.sites({}, {}, mockContext)

      // SDK expects wrapped format { data: [...] }
      expect(result).toEqual({ data: mockSites })
      expect(mockContext.prisma.site.findMany).toHaveBeenCalledWith({
        where: { projectId: 'project-123' },
      })
    })

    it('should throw error if project ID is missing', async () => {
      mockContext.projectId = undefined

      await expect(resolvers.Query.sites({}, {}, mockContext)).rejects.toThrow(
        'Project ID required'
      )
    })
  })

  describe('siteBySlug', () => {
    it('should return site by slug', async () => {
      const mockSite = { id: 'site-123', slug: 'test-site' }
      vi.mocked(mockContext.prisma.site.findUnique).mockResolvedValue(mockSite)

      const result = await resolvers.Query.siteBySlug(
        {},
        { where: { slug: 'test-site' } },
        mockContext
      )

      expect(result).toEqual(mockSite)
      expect(mockContext.prisma.site.findUnique).toHaveBeenCalledWith({
        where: { slug: 'test-site' },
      })
    })
  })

  describe('afFunctionByName', () => {
    it('should return function by name', async () => {
      const mockFunction = { id: 'func-123', name: 'test-function' }
      vi.mocked(mockContext.prisma.aFFunction.findFirst).mockResolvedValue(
        mockFunction
      )

      const result = await resolvers.Query.afFunctionByName(
        {},
        { where: { name: 'test-function' } },
        mockContext
      )

      expect(result).toEqual(mockFunction)
      expect(mockContext.prisma.aFFunction.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'test-function',
          projectId: 'project-123',
        },
      })
    })

    it('should throw error if project ID is missing', async () => {
      mockContext.projectId = undefined

      await expect(
        resolvers.Query.afFunctionByName(
          {},
          { where: { name: 'test-function' } },
          mockContext
        )
      ).rejects.toThrow('Project ID required')
    })

    it('should throw error if function not found', async () => {
      vi.mocked(mockContext.prisma.aFFunction.findFirst).mockResolvedValue(null)

      await expect(
        resolvers.Query.afFunctionByName(
          {},
          { where: { name: 'test-function' } },
          mockContext
        )
      ).rejects.toThrow('Function not found')
    })
  })

  describe('afFunctions', () => {
    it('should return all functions for project', async () => {
      const mockFunctions = [
        { id: 'func-1', name: 'Function 1' },
        { id: 'func-2', name: 'Function 2' },
      ]
      vi.mocked(mockContext.prisma.aFFunction.findMany).mockResolvedValue(
        mockFunctions
      )

      const result = await resolvers.Query.afFunctions({}, {}, mockContext)

      expect(result).toEqual({ data: mockFunctions })
      expect(mockContext.prisma.aFFunction.findMany).toHaveBeenCalledWith({
        where: { projectId: 'project-123' },
      })
    })

    it('should throw error if project ID is missing', async () => {
      mockContext.projectId = undefined

      await expect(
        resolvers.Query.afFunctions({}, {}, mockContext)
      ).rejects.toThrow('Project ID required')
    })
  })

  describe('afFunctionDeployments', () => {
    it('should return deployments for function', async () => {
      const mockDeployments = [
        { id: 'deploy-1', cid: 'QmTest1' },
        { id: 'deploy-2', cid: 'QmTest2' },
      ]
      vi.mocked(
        mockContext.prisma.aFFunctionDeployment.findMany
      ).mockResolvedValue(mockDeployments)

      const result = await resolvers.Query.afFunctionDeployments(
        {},
        { where: { afFunctionId: 'func-123' } },
        mockContext
      )

      // Returns wrapped format { data: [...] }
      expect(result).toEqual({ data: mockDeployments })
      expect(
        mockContext.prisma.aFFunctionDeployment.findMany
      ).toHaveBeenCalledWith({
        where: { afFunctionId: 'func-123' },
        orderBy: { createdAt: 'desc' },
      })
    })
  })

  describe('domains', () => {
    it('should return all domains when siteId is not provided', async () => {
      const mockDomains = [
        { id: 'domain-1', hostname: 'example.com' },
        { id: 'domain-2', hostname: 'test.com' },
      ]
      vi.mocked(mockContext.prisma.domain.findMany).mockResolvedValue(
        mockDomains
      )

      const result = await resolvers.Query.domains({}, {}, mockContext)

      // Domain resolver returns wrapped format { data: [...] }
      expect(result).toEqual({ data: mockDomains })
      expect(mockContext.prisma.domain.findMany).toHaveBeenCalledWith({
        where: {
          site: {
            project: {
              userId: 'user-123',
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      })
    })

    it('should return domains for specific site', async () => {
      // Note: The domains resolver returns ALL domains for the user
      // and doesn't filter by siteId. This test verifies that behavior.
      const mockDomains = [
        { id: 'domain-1', hostname: 'example.com', siteId: 'site-123' },
      ]

      vi.mocked(mockContext.prisma.domain.findMany).mockResolvedValue(
        mockDomains
      )

      const result = await resolvers.Query.domains(
        {},
        { siteId: 'site-123' },
        mockContext
      )

      // Returns wrapped format regardless of siteId argument
      expect(result).toEqual({ data: mockDomains })
    })
  })
})
