import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvers } from './index.js'
import type { Context } from './index.js'

describe('Field Resolvers', () => {
  let mockContext: Context

  beforeEach(() => {
    vi.clearAllMocks()

    mockContext = {
      prisma: {
        project: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
        },
        user: {
          findUnique: vi.fn(),
        },
        site: {
          findMany: vi.fn(),
        },
        aFFunction: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
        },
        aFFunctionDeployment: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
        },
        deployment: {
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

  describe('User field resolvers', () => {
    it('should resolve user projects', async () => {
      const mockProjects = [
        { id: 'project-1', name: 'Project 1' },
        { id: 'project-2', name: 'Project 2' },
      ]
      vi.mocked(mockContext.prisma.project.findMany).mockResolvedValue(
        mockProjects
      )

      const result = await resolvers.User.projects(
        { id: 'user-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockProjects)
      expect(mockContext.prisma.project.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      })
    })
  })

  describe('Project field resolvers', () => {
    it('should resolve project user', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' }
      vi.mocked(mockContext.prisma.user.findUnique).mockResolvedValue(mockUser)

      const result = await resolvers.Project.user(
        { id: 'project-123', userId: 'user-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockUser)
      expect(mockContext.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      })
    })

    it('should resolve project sites', async () => {
      const mockSites = [
        { id: 'site-1', name: 'Site 1' },
        { id: 'site-2', name: 'Site 2' },
      ]
      vi.mocked(mockContext.prisma.site.findMany).mockResolvedValue(mockSites)

      const result = await resolvers.Project.sites(
        { id: 'project-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockSites)
      expect(mockContext.prisma.site.findMany).toHaveBeenCalledWith({
        where: { projectId: 'project-123' },
      })
    })

    it('should resolve project functions', async () => {
      const mockFunctions = [
        { id: 'func-1', name: 'Function 1' },
        { id: 'func-2', name: 'Function 2' },
      ]
      vi.mocked(mockContext.prisma.aFFunction.findMany).mockResolvedValue(
        mockFunctions
      )

      const result = await resolvers.Project.functions(
        { id: 'project-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockFunctions)
      expect(mockContext.prisma.aFFunction.findMany).toHaveBeenCalledWith({
        where: { projectId: 'project-123' },
      })
    })
  })

  describe('Site field resolvers', () => {
    it('should resolve site project', async () => {
      const mockProject = { id: 'project-123', name: 'Test Project' }
      vi.mocked(mockContext.prisma.project.findUnique).mockResolvedValue(
        mockProject
      )

      const result = await resolvers.Site.project(
        { id: 'site-123', projectId: 'project-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockProject)
      expect(mockContext.prisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: 'project-123' },
      })
    })

    it('should resolve site deployments', async () => {
      const mockDeployments = [
        { id: 'deploy-1', cid: 'QmTest1' },
        { id: 'deploy-2', cid: 'QmTest2' },
      ]
      vi.mocked(mockContext.prisma.deployment.findMany).mockResolvedValue(
        mockDeployments
      )

      const result = await resolvers.Site.deployments(
        { id: 'site-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockDeployments)
      expect(mockContext.prisma.deployment.findMany).toHaveBeenCalledWith({
        where: { siteId: 'site-123' },
      })
    })

    it('should resolve site domains', async () => {
      const mockDomains = [
        { id: 'domain-1', hostname: 'example.com' },
        { id: 'domain-2', hostname: 'test.com' },
      ]
      vi.mocked(mockContext.prisma.domain.findMany).mockResolvedValue(
        mockDomains
      )

      const result = await resolvers.Site.domains(
        { id: 'site-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockDomains)
      expect(mockContext.prisma.domain.findMany).toHaveBeenCalledWith({
        where: { siteId: 'site-123' },
      })
    })
  })

  describe('AFFunction field resolvers', () => {
    it('should resolve function project', async () => {
      const mockProject = { id: 'project-123', name: 'Test Project' }
      vi.mocked(mockContext.prisma.project.findUnique).mockResolvedValue(
        mockProject
      )

      const result = await resolvers.AFFunction.project(
        { id: 'func-123', projectId: 'project-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockProject)
      expect(mockContext.prisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: 'project-123' },
      })
    })

    it('should resolve function current deployment', async () => {
      const mockDeployment = { id: 'deploy-123', cid: 'QmTest123' }
      vi.mocked(
        mockContext.prisma.aFFunctionDeployment.findUnique
      ).mockResolvedValue(mockDeployment)

      const result = await resolvers.AFFunction.currentDeployment(
        { id: 'func-123', currentDeploymentId: 'deploy-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockDeployment)
      expect(
        mockContext.prisma.aFFunctionDeployment.findUnique
      ).toHaveBeenCalledWith({
        where: { id: 'deploy-123' },
      })
    })

    it('should return null when currentDeploymentId is not set', async () => {
      const result = await resolvers.AFFunction.currentDeployment(
        { id: 'func-123', currentDeploymentId: null },
        {},
        mockContext
      )

      expect(result).toBeNull()
      expect(
        mockContext.prisma.aFFunctionDeployment.findUnique
      ).not.toHaveBeenCalled()
    })

    it('should resolve function deployments', async () => {
      const mockDeployments = [
        { id: 'deploy-1', cid: 'QmTest1' },
        { id: 'deploy-2', cid: 'QmTest2' },
      ]
      vi.mocked(
        mockContext.prisma.aFFunctionDeployment.findMany
      ).mockResolvedValue(mockDeployments)

      const result = await resolvers.AFFunction.deployments(
        { id: 'func-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockDeployments)
      expect(
        mockContext.prisma.aFFunctionDeployment.findMany
      ).toHaveBeenCalledWith({
        where: { afFunctionId: 'func-123' },
        orderBy: { createdAt: 'desc' },
      })
    })
  })

  describe('AFFunctionDeployment field resolvers', () => {
    it('should resolve deployment function', async () => {
      const mockFunction = { id: 'func-123', name: 'Test Function' }
      vi.mocked(mockContext.prisma.aFFunction.findUnique).mockResolvedValue(
        mockFunction
      )

      const result = await resolvers.AFFunctionDeployment.afFunction(
        { id: 'deploy-123', afFunctionId: 'func-123' },
        {},
        mockContext
      )

      expect(result).toEqual(mockFunction)
      expect(mockContext.prisma.aFFunction.findUnique).toHaveBeenCalledWith({
        where: { id: 'func-123' },
      })
    })
  })
})
