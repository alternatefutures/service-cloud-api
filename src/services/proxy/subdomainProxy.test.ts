import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock http-proxy before importing the module under test
const mockProxyWeb = vi.fn()
const mockProxyWs = vi.fn()
const mockProxyOn = vi.fn()

vi.mock('http-proxy', () => ({
  default: {
    createProxyServer: () => ({
      web: mockProxyWeb,
      ws: mockProxyWs,
      on: mockProxyOn,
    }),
  },
}))

import { SubdomainProxy } from './subdomainProxy.js'
import type { ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn()

const mockPrisma = {
  service: { findFirst: mockFindFirst },
} as any

// ---------------------------------------------------------------------------
// Helper to create a mock ServerResponse
// ---------------------------------------------------------------------------

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res: any = {
    _status: 0,
    _body: '',
    headersSent: false,
    writeHead(status: number, _headers?: any) {
      res._status = status
      return res
    },
    end(body?: string) {
      res._body = body || ''
      return res
    },
  }
  return res
}

function mockReq(host: string, url = '/'): any {
  return {
    headers: { host },
    url,
    method: 'GET',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubdomainProxy', () => {
  let proxy: SubdomainProxy

  beforeEach(() => {
    vi.clearAllMocks()
    proxy = new SubdomainProxy(mockPrisma)
  })

  // ── parseSubdomain ──────────────────────────────────────────────────────

  describe('parseSubdomain', () => {
    it('should parse -app subdomain', () => {
      const result = proxy.parseSubdomain('my-service-app.alternatefutures.ai')
      expect(result).toEqual({ tier: 'apps', slug: 'my-service' })
    })

    it('should parse -agent subdomain', () => {
      const result = proxy.parseSubdomain('code-reviewer-agent.alternatefutures.ai')
      expect(result).toEqual({ tier: 'agents', slug: 'code-reviewer' })
    })

    it('should strip port before parsing', () => {
      const result = proxy.parseSubdomain('my-service-app.alternatefutures.ai:443')
      expect(result).toEqual({ tier: 'apps', slug: 'my-service' })
    })

    it('should be case-insensitive', () => {
      const result = proxy.parseSubdomain('My-Service-App.AlternateFutures.AI')
      expect(result).toEqual({ tier: 'apps', slug: 'my-service' })
    })

    it('should return null for bare domain', () => {
      expect(proxy.parseSubdomain('alternatefutures.ai')).toBeNull()
    })

    it('should return null for subdomains without -app or -agent suffix', () => {
      expect(proxy.parseSubdomain('api.alternatefutures.ai')).toBeNull()
    })

    it('should return null for "app" subdomain (no slug prefix)', () => {
      expect(proxy.parseSubdomain('app.alternatefutures.ai')).toBeNull()
    })

    it('should return null for infrastructure subdomains', () => {
      expect(proxy.parseSubdomain('api.alternatefutures.ai')).toBeNull()
      expect(proxy.parseSubdomain('auth.alternatefutures.ai')).toBeNull()
    })

    it('should return null for nested subdomains', () => {
      expect(proxy.parseSubdomain('deep.nested-app.alternatefutures.ai')).toBeNull()
    })

    it('should return null for unrelated domains', () => {
      expect(proxy.parseSubdomain('example.com')).toBeNull()
    })

    it('should return null for empty host', () => {
      expect(proxy.parseSubdomain('')).toBeNull()
    })

    it('should handle slug that contains -app in the middle', () => {
      const result = proxy.parseSubdomain('my-app-service-app.alternatefutures.ai')
      expect(result).toEqual({ tier: 'apps', slug: 'my-app-service' })
    })

    it('should handle slug that contains -agent in the middle', () => {
      const result = proxy.parseSubdomain('smart-agent-bot-agent.alternatefutures.ai')
      expect(result).toEqual({ tier: 'agents', slug: 'smart-agent-bot' })
    })
  })

  // ── handleRequest ───────────────────────────────────────────────────────

  describe('handleRequest', () => {
    it('should return false for non-proxied hosts', async () => {
      const req = mockReq('api.alternatefutures.ai')
      const res = mockRes()
      const handled = await proxy.handleRequest(req, res)
      expect(handled).toBe(false)
    })

    it('should return 404 when service slug not found', async () => {
      mockFindFirst.mockResolvedValue(null)
      const req = mockReq('unknown-app.alternatefutures.ai')
      const res = mockRes()

      const handled = await proxy.handleRequest(req, res)

      expect(handled).toBe(true)
      expect(res._status).toBe(404)
      expect(JSON.parse(res._body).error).toBe('Not Found')
    })

    it('should return 503 when service has no active deployment', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'FUNCTION',
        akashDeployments: [],
        phalaDeployments: [],
      })
      const req = mockReq('my-func-app.alternatefutures.ai')
      const res = mockRes()

      const handled = await proxy.handleRequest(req, res)

      expect(handled).toBe(true)
      expect(res._status).toBe(503)
      expect(JSON.parse(res._body).error).toBe('Service Unavailable')
    })

    it('should return 502 on database error', async () => {
      mockFindFirst.mockRejectedValue(new Error('DB connection lost'))
      const req = mockReq('my-func-app.alternatefutures.ai')
      const res = mockRes()

      const handled = await proxy.handleRequest(req, res)

      expect(handled).toBe(true)
      expect(res._status).toBe(502)
    })

    it('should look up service by slug with correct Prisma query', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'FUNCTION',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.gpu.subangle.com:31192'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })
      const req = mockReq('my-func-app.alternatefutures.ai')
      const res = mockRes()

      await proxy.handleRequest(req, res)

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { slug: 'my-func' },
        select: expect.objectContaining({
          id: true,
          type: true,
          akashDeployments: expect.any(Object),
          phalaDeployments: expect.any(Object),
        }),
      })
    })

    it('should proxy to Akash backend with correct target', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'FUNCTION',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.gpu.subangle.com:31192'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })
      const req = mockReq('my-func-app.alternatefutures.ai')
      const res = mockRes()

      const handled = await proxy.handleRequest(req, res)

      expect(handled).toBe(true)
      expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
        target: 'http://provider.gpu.subangle.com:31192',
      })
    })

    it('should set forwarding headers', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.example.com:8080'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })
      const req = mockReq('my-vm-app.alternatefutures.ai')
      const res = mockRes()

      await proxy.handleRequest(req, res)

      expect(req.headers['x-forwarded-host']).toBe('my-vm-app.alternatefutures.ai')
      expect(req.headers['x-forwarded-proto']).toBe('https')
      expect(req.headers['x-af-tier']).toBe('apps')
      expect(req.headers['x-af-slug']).toBe('my-vm')
    })

    it('should use cached result on second request', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.example.com:8080'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })

      const req1 = mockReq('cached-svc-app.alternatefutures.ai')
      const res1 = mockRes()
      await proxy.handleRequest(req1, res1)

      const req2 = mockReq('cached-svc-app.alternatefutures.ai')
      const res2 = mockRes()
      await proxy.handleRequest(req2, res2)

      // DB should only be called once
      expect(mockFindFirst).toHaveBeenCalledTimes(1)
      // Proxy called twice
      expect(mockProxyWeb).toHaveBeenCalledTimes(2)
    })

    it('should invalidate cache for a slug', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.example.com:8080'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })

      const req1 = mockReq('evict-me-app.alternatefutures.ai')
      const res1 = mockRes()
      await proxy.handleRequest(req1, res1)

      proxy.invalidateSlug('evict-me', 'apps')

      const req2 = mockReq('evict-me-app.alternatefutures.ai')
      const res2 = mockRes()
      await proxy.handleRequest(req2, res2)

      // DB called twice after invalidation
      expect(mockFindFirst).toHaveBeenCalledTimes(2)
    })

    it('should prefer Akash deployment over Phala', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['akash-provider.com:9090'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [{
          appUrl: 'https://phala-app.example.com',
          status: 'ACTIVE',
        }],
      })

      const req = mockReq('dual-deploy-app.alternatefutures.ai')
      const res = mockRes()
      await proxy.handleRequest(req, res)

      expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
        target: 'http://akash-provider.com:9090',
      })
    })

    it('should fall back to Phala when no Akash deployment', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [],
        phalaDeployments: [{
          appUrl: 'https://phala-app.example.com',
          status: 'ACTIVE',
        }],
      })

      const req = mockReq('phala-only-app.alternatefutures.ai')
      const res = mockRes()
      await proxy.handleRequest(req, res)

      expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
        target: 'https://phala-app.example.com',
      })
    })

    it('should handle agents tier error messages', async () => {
      mockFindFirst.mockResolvedValue(null)
      const req = mockReq('my-bot-agent.alternatefutures.ai')
      const res = mockRes()

      await proxy.handleRequest(req, res)

      expect(res._status).toBe(404)
      expect(JSON.parse(res._body).message).toContain('agent')
    })

    it('should handle Akash URIs that already have http prefix', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'FUNCTION',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['http://provider.example.com:8080'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })
      const req = mockReq('prefixed-app.alternatefutures.ai')
      const res = mockRes()

      await proxy.handleRequest(req, res)

      expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
        target: 'http://provider.example.com:8080',
      })
    })
  })

  // ── flushCache ──────────────────────────────────────────────────────────

  describe('flushCache', () => {
    it('should clear all cached entries', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'svc-1',
        type: 'VM',
        akashDeployments: [{
          serviceUrls: { web: { uris: ['provider.example.com:8080'] } },
          status: 'ACTIVE',
        }],
        phalaDeployments: [],
      })

      const req = mockReq('flush-test-app.alternatefutures.ai')
      const res = mockRes()
      await proxy.handleRequest(req, res)

      proxy.flushCache()

      const req2 = mockReq('flush-test-app.alternatefutures.ai')
      const res2 = mockRes()
      await proxy.handleRequest(req2, res2)

      expect(mockFindFirst).toHaveBeenCalledTimes(2)
    })
  })
})
