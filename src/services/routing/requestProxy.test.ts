import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RequestProxy, ProxyError } from './requestProxy.js'
import type { RouteMatch } from './routeMatcher.js'
import type { ProxyRequest } from './requestProxy.js'

// Mock fetch globally
global.fetch = vi.fn()

describe('RequestProxy', () => {
  let proxy: RequestProxy

  beforeEach(() => {
    proxy = new RequestProxy()
    vi.clearAllMocks()
  })

  describe('successful proxying', () => {
    it('should proxy GET request', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: {
          host: 'gateway.example.com',
          'user-agent': 'Test/1.0',
        },
      }

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-custom', 'value'],
        ]),
        json: vi.fn().mockResolvedValue({ users: [] }),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const response = await proxy.proxy(
        match,
        request,
        'https://api.example.com/users'
      )

      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'user-agent': 'Test/1.0',
            'X-Forwarded-Host': 'gateway.example.com',
          }),
        })
      )

      expect(response).toEqual({
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'value',
        },
        body: { users: [] },
      })
    })

    it('should proxy POST request with body', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'POST',
        path: '/api/users',
        headers: {
          host: 'gateway.example.com',
          'content-type': 'application/json',
        },
        body: { name: 'John', email: 'john@example.com' },
      }

      const mockResponse = {
        status: 201,
        statusText: 'Created',
        headers: new Map([['content-type', 'application/json']]),
        json: vi.fn().mockResolvedValue({ id: '123' }),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const response = await proxy.proxy(
        match,
        request,
        'https://api.example.com/users'
      )

      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'John', email: 'john@example.com' }),
        })
      )

      expect(response.status).toBe(201)
      expect(response.body).toEqual({ id: '123' })
    })

    it('should handle query parameters', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: { host: 'gateway.example.com' },
        query: {
          page: '1',
          limit: '10',
          sort: ['name', 'email'],
        },
      }

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: vi.fn().mockResolvedValue({ users: [] }),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      await proxy.proxy(match, request, 'https://api.example.com/users')

      const callUrl = vi.mocked(fetch).mock.calls[0][0] as string
      expect(callUrl).toContain('page=1')
      expect(callUrl).toContain('limit=10')
      expect(callUrl).toContain('sort=name')
      expect(callUrl).toContain('sort=email')
    })

    it('should handle non-JSON responses', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/health',
        wildcardPath: 'health',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/health',
        headers: { host: 'gateway.example.com' },
      }

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'text/plain']]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      const response = await proxy.proxy(
        match,
        request,
        'https://api.example.com/health'
      )

      expect(response.body).toBe('OK')
    })
  })

  describe('header handling', () => {
    it('should add X-Forwarded headers', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: {
          host: 'gateway.example.com',
        },
      }

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      await proxy.proxy(match, request, 'https://api.example.com/users')

      const callHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<
        string,
        string
      >

      expect(callHeaders['X-Forwarded-Host']).toBe('gateway.example.com')
      expect(callHeaders['X-Forwarded-Proto']).toBe('https')
      expect(callHeaders['X-Forwarded-For']).toBeTruthy()
    })

    it('should filter hop-by-hop headers', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: {
          host: 'gateway.example.com',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          upgrade: 'websocket',
          'transfer-encoding': 'chunked',
        },
      }

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: vi.fn().mockResolvedValue('OK'),
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse as any)

      await proxy.proxy(match, request, 'https://api.example.com/users')

      const callHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<
        string,
        string
      >

      expect(callHeaders['host']).toBeUndefined()
      expect(callHeaders['connection']).toBeUndefined()
      expect(callHeaders['keep-alive']).toBeUndefined()
      expect(callHeaders['upgrade']).toBeUndefined()
      expect(callHeaders['transfer-encoding']).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('should throw ProxyError on network failure', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: { host: 'gateway.example.com' },
      }

      vi.mocked(fetch).mockRejectedValue(new TypeError('Network error'))

      await expect(
        proxy.proxy(match, request, 'https://api.example.com/users')
      ).rejects.toThrow(ProxyError)

      await expect(
        proxy.proxy(match, request, 'https://api.example.com/users')
      ).rejects.toThrow('Failed to connect')
    })

    it('should handle timeout', async () => {
      const proxyWithTimeout = new RequestProxy({ timeout: 100 })

      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: { host: 'gateway.example.com' },
      }

      // Simulate timeout by rejecting with AbortError
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise((_, reject) => {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            setTimeout(() => reject(error), 50)
          })
      )

      await expect(
        proxyWithTimeout.proxy(match, request, 'https://api.example.com/users')
      ).rejects.toThrow('timed out')
    })

    it('should include status code in ProxyError', async () => {
      const match: RouteMatch = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      }

      const request: ProxyRequest = {
        method: 'GET',
        path: '/api/users',
        headers: { host: 'gateway.example.com' },
      }

      vi.mocked(fetch).mockRejectedValue(new TypeError('Connection refused'))

      try {
        await proxy.proxy(match, request, 'https://api.example.com/users')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ProxyError)
        expect((error as ProxyError).statusCode).toBe(502)
      }
    })
  })
})
