import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RuntimeRouter } from './runtimeRouter.js'
import type { PrismaClient } from '@prisma/client'
import type { ProxyRequest } from './requestProxy.js'

// Mock fetch globally
global.fetch = vi.fn()

// Mock Prisma
const mockPrisma = {
  aFFunction: {
    findUnique: vi.fn(),
  },
} as unknown as PrismaClient

describe('RuntimeRouter', () => {
  let router: RuntimeRouter

  beforeEach(() => {
    router = new RuntimeRouter(mockPrisma, {
      cacheTTL: 60, // 1 minute for testing
      proxyTimeout: 5000,
    })
    vi.clearAllMocks()
  })

  describe('handleRequest', () => {
    it('should return null when function has no routes configured', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: null,
        status: 'ACTIVE',
      } as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: { host: 'gateway.example.com' },
      }

      const response = await router.handleRequest('func-123', request)

      expect(response).toBeNull()
    })

    it('should return null when no route matches', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/users/*': 'https://users.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/products/123',
        headers: { host: 'gateway.example.com' },
      }

      const response = await router.handleRequest('func-123', request)

      expect(response).toBeNull()
    })

    it('should proxy request when route matches', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/users/*': 'https://users.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: vi.fn().mockResolvedValue({ users: [] }),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users/123',
        headers: { host: 'gateway.example.com' },
      }

      const response = await router.handleRequest('func-123', request)

      expect(response).not.toBeNull()
      expect(response?.status).toBe(200)
      expect(response?.body).toEqual({ users: [] })

      // Verify fetch was called with correct URL
      expect(fetch).toHaveBeenCalledWith(
        'https://users.example.com/123',
        expect.anything()
      )
    })

    it('should use cached routes on subsequent requests', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/*': 'https://api.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/test',
        headers: { host: 'gateway.example.com' },
      }

      // First request - should hit database
      await router.handleRequest('func-123', request)
      expect(mockPrisma.aFFunction.findUnique).toHaveBeenCalledTimes(1)

      // Second request - should use cache
      await router.handleRequest('func-123', request)
      expect(mockPrisma.aFFunction.findUnique).toHaveBeenCalledTimes(1) // Still 1
    })

    it('should handle function with multiple routes', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/auth/*': 'https://auth.example.com',
          '/api/users/*': 'https://users.example.com',
          '/api/*': 'https://api.example.com',
          '/*': 'https://default.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      // Test auth route
      await router.handleRequest('func-123', {
        method: 'GET',
        path: '/api/auth/login',
        headers: { host: 'gateway.example.com' },
      })
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://auth.example.com/login'
      )

      // Test users route
      await router.handleRequest('func-123', {
        method: 'GET',
        path: '/api/users/123',
        headers: { host: 'gateway.example.com' },
      })
      expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
        'https://users.example.com/123'
      )

      // Test API fallback
      await router.handleRequest('func-123', {
        method: 'GET',
        path: '/api/products',
        headers: { host: 'gateway.example.com' },
      })
      expect(vi.mocked(fetch).mock.calls[2][0]).toBe(
        'https://api.example.com/products'
      )

      // Test default fallback
      await router.handleRequest('func-123', {
        method: 'GET',
        path: '/homepage',
        headers: { host: 'gateway.example.com' },
      })
      expect(vi.mocked(fetch).mock.calls[3][0]).toBe(
        'https://default.example.com/homepage'
      )
    })

    it('should return error response on proxy failure', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/*': 'https://api.example.com',
        },
        status: 'ACTIVE',
      } as any)

      vi.mocked(fetch).mockRejectedValue(new TypeError('Network error'))

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/test',
        headers: { host: 'gateway.example.com' },
      }

      const response = await router.handleRequest('func-123', request)

      expect(response).not.toBeNull()
      expect(response?.status).toBe(502)
      expect(response?.body).toHaveProperty('error')
    })

    it('should skip inactive functions', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/*': 'https://api.example.com',
        },
        status: 'INACTIVE',
      } as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/test',
        headers: { host: 'gateway.example.com' },
      }

      const response = await router.handleRequest('func-123', request)

      expect(response).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('cache management', () => {
    it('should invalidate cache for specific function', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/*': 'https://api.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/test',
        headers: { host: 'gateway.example.com' },
      }

      // First request
      await router.handleRequest('func-123', request)
      expect(mockPrisma.aFFunction.findUnique).toHaveBeenCalledTimes(1)

      // Invalidate cache
      router.invalidateCache('func-123')

      // Second request - should hit database again
      await router.handleRequest('func-123', request)
      expect(mockPrisma.aFFunction.findUnique).toHaveBeenCalledTimes(2)
    })

    it('should clear all cache', async () => {
      vi.mocked(mockPrisma.aFFunction.findUnique).mockResolvedValue({
        id: 'func-123',
        routes: {
          '/api/*': 'https://api.example.com',
        },
        status: 'ACTIVE',
      } as any)

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/test',
        headers: { host: 'gateway.example.com' },
      }

      // Cache routes
      await router.handleRequest('func-123', request)

      // Clear all cache
      router.clearCache()

      // Next request should hit database
      await router.handleRequest('func-123', request)
      expect(mockPrisma.aFFunction.findUnique).toHaveBeenCalledTimes(2)
    })

    it('should provide cache statistics', () => {
      const stats = router.getStats()

      expect(stats).toHaveProperty('cache')
      expect(stats.cache).toHaveProperty('size')
      expect(stats.cache).toHaveProperty('ttl')
    })
  })
})
