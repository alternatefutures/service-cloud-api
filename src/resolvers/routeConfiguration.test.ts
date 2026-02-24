import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolvers } from './index.js'
import { GraphQLError } from 'graphql'

describe('Route Configuration Resolvers', () => {
  let mockContext: any

  // Shared mock for transaction's aFFunction.create
  let mockTxAFFunctionCreate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockTxAFFunctionCreate = vi.fn()

    const mockTx = {
      project: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'project-123', slug: 'test-project' }),
      },
      service: {
        create: vi.fn().mockResolvedValue({ id: 'service-1' }),
      },
      aFFunction: {
        create: mockTxAFFunctionCreate,
        update: vi.fn(),
      },
    }

    mockContext = {
      prisma: {
        aFFunction: {
          create: vi.fn(),
          update: vi.fn(),
          findUnique: vi.fn(),
        },
        $transaction: vi.fn().mockImplementation(async (callback: any) => {
          return callback(mockTx)
        }),
      },
      projectId: 'project-123',
      userId: 'user-123',
    }
  })

  describe('createAFFunction with routes', () => {
    it('should create function without routes', async () => {
      const mockFunction = {
        id: 'func-1',
        name: 'Test Function',
        slug: 'test-function',
        invokeUrl: 'https://test.com/test-function',
        routes: null,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockTxAFFunctionCreate.mockResolvedValue(mockFunction)

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { data: { name: 'Test Function' } },
        mockContext
      )

      expect(result).toEqual(mockFunction)
      expect(mockTxAFFunctionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Test Function',
          slug: 'test-function',
          projectId: 'project-123',
          status: 'ACTIVE',
        }),
      })
    })

    it('should create function with valid routes', async () => {
      const validRoutes = {
        '/api/users/*': 'https://users-service.com',
        '/api/products/*': 'https://products-service.com',
        '/*': 'https://default.com',
      }

      const mockFunction = {
        id: 'func-1',
        name: 'Gateway Function',
        slug: 'gateway-function',
        invokeUrl: 'https://test.com/gateway-function',
        routes: validRoutes,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockTxAFFunctionCreate.mockResolvedValue(mockFunction)

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { data: { name: 'Gateway Function', routes: validRoutes } },
        mockContext
      )

      expect(result).toEqual(mockFunction)
      expect(mockTxAFFunctionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Gateway Function',
          routes: validRoutes,
        }),
      })
    })

    it('should reject function creation with invalid routes', async () => {
      const invalidRoutes = {
        'invalid-path': 'not-a-url',
      }

      await expect(
        resolvers.Mutation.createAFFunction(
          {},
          { data: { name: 'Test Function', routes: invalidRoutes } },
          mockContext
        )
      ).rejects.toThrow(GraphQLError)

      expect(mockContext.prisma.aFFunction.create).not.toHaveBeenCalled()
    })

    it('should reject routes with non-http protocols', async () => {
      const invalidRoutes = {
        '/api': 'ftp://example.com',
      }

      await expect(
        resolvers.Mutation.createAFFunction(
          {},
          { data: { name: 'Test Function', routes: invalidRoutes } },
          mockContext
        )
      ).rejects.toThrow(GraphQLError)
    })

    it('should reject empty routes object', async () => {
      await expect(
        resolvers.Mutation.createAFFunction(
          {},
          { data: { name: 'Test Function', routes: {} } },
          mockContext
        )
      ).rejects.toThrow(GraphQLError)
    })

    it('should require project ID', async () => {
      const contextWithoutProject = {
        ...mockContext,
        projectId: undefined,
      }

      await expect(
        resolvers.Mutation.createAFFunction(
          {},
          { data: { name: 'Test Function' } },
          contextWithoutProject
        )
      ).rejects.toThrow(GraphQLError)
      expect(() => {
        throw new GraphQLError('Project ID required')
      }).toThrow('Project ID required')
    })
  })

  describe('updateAFFunction with routes', () => {
    it('should update function with new routes', async () => {
      const newRoutes = {
        '/api/*': 'https://new-api.com',
      }

      const mockUpdatedFunction = {
        id: 'func-1',
        name: 'Updated Function',
        slug: 'updated-function',
        routes: newRoutes,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockContext.prisma.aFFunction.update.mockResolvedValue(
        mockUpdatedFunction
      )

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { where: { id: 'func-1' }, data: { routes: newRoutes } },
        mockContext
      )

      expect(result).toEqual(mockUpdatedFunction)
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-1' },
        data: expect.objectContaining({
          routes: newRoutes,
        }),
      })
    })

    it('should update function with null routes (clear routes)', async () => {
      const mockUpdatedFunction = {
        id: 'func-1',
        name: 'Function',
        slug: 'function',
        routes: null,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockContext.prisma.aFFunction.update.mockResolvedValue(
        mockUpdatedFunction
      )

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { where: { id: 'func-1' }, data: { routes: null } },
        mockContext
      )

      expect(result).toEqual(mockUpdatedFunction)
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-1' },
        data: expect.objectContaining({
          routes: null,
        }),
      })
    })

    it('should reject update with invalid routes', async () => {
      const invalidRoutes = {
        'no-slash': 'https://example.com',
      }

      await expect(
        resolvers.Mutation.updateAFFunction(
          {},
          { where: { id: 'func-1' }, data: { routes: invalidRoutes } },
          mockContext
        )
      ).rejects.toThrow(GraphQLError)

      expect(mockContext.prisma.aFFunction.update).not.toHaveBeenCalled()
    })

    it('should update other fields without affecting routes', async () => {
      const mockUpdatedFunction = {
        id: 'func-1',
        name: 'New Name',
        slug: 'new-slug',
        routes: null,
        status: 'INACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockContext.prisma.aFFunction.update.mockResolvedValue(
        mockUpdatedFunction
      )

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { where: { id: 'func-1' }, data: { name: 'New Name', status: 'INACTIVE' } },
        mockContext
      )

      expect(result).toEqual(mockUpdatedFunction)
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-1' },
        data: expect.objectContaining({
          name: 'New Name',
          status: 'INACTIVE',
        }),
      })
    })

    it('should update multiple fields including routes', async () => {
      const newRoutes = {
        '/v2/*': 'https://v2-api.com',
      }

      const mockUpdatedFunction = {
        id: 'func-1',
        name: 'Updated Name',
        slug: 'updated-slug',
        routes: newRoutes,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockContext.prisma.aFFunction.update.mockResolvedValue(
        mockUpdatedFunction
      )

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        {
          where: { id: 'func-1' },
          data: {
            name: 'Updated Name',
            slug: 'updated-slug',
            routes: newRoutes,
          },
        },
        mockContext
      )

      expect(result).toEqual(mockUpdatedFunction)
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-1' },
        data: expect.objectContaining({
          name: 'Updated Name',
          slug: 'updated-slug',
          routes: newRoutes,
        }),
      })
    })
  })

  describe('Route configuration edge cases', () => {
    it('should handle complex route patterns', async () => {
      const complexRoutes = {
        '/api/v1/users/*': 'https://users-v1.com',
        '/api/v2/users/*': 'https://users-v2.com',
        '/api/*/legacy': 'https://legacy.com',
        '/*': 'https://default.com',
      }

      const mockFunction = {
        id: 'func-1',
        name: 'Complex Function',
        slug: 'complex-function',
        routes: complexRoutes,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockTxAFFunctionCreate.mockResolvedValue(mockFunction)

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { data: { name: 'Complex Function', routes: complexRoutes } },
        mockContext
      )

      expect(result.routes).toEqual(complexRoutes)
    })

    it('should handle URLs with paths and query parameters', async () => {
      const routesWithParams = {
        '/api': 'https://example.com/base/path?key=value&foo=bar',
      }

      const mockFunction = {
        id: 'func-1',
        name: 'Param Function',
        slug: 'param-function',
        routes: routesWithParams,
        status: 'ACTIVE',
        projectId: 'project-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockTxAFFunctionCreate.mockResolvedValue(mockFunction)

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { data: { name: 'Param Function', routes: routesWithParams } },
        mockContext
      )

      expect(result.routes).toEqual(routesWithParams)
    })
  })
})
