/**
 * Subdomain Reverse Proxy
 *
 * Routes requests using single-level subdomains under *.alternatefutures.ai:
 *   {slug}-app.alternatefutures.ai   -> app deployments
 *   {slug}-agent.alternatefutures.ai -> agent deployments
 *
 * Uses single-level subdomains so Cloudflare's free Universal SSL
 * (which covers *.alternatefutures.ai) handles TLS without needing
 * Advanced Certificate Manager.
 *
 * Architecture:
 *   User -> Cloudflare (wildcard DNS) -> Traefik (K3s) -> this proxy -> Akash/Phala provider
 */

/* eslint-disable no-console */
import httpProxy from 'http-proxy'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Base domain for user deployments (set via env or default) */
const BASE_DOMAIN = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'

/** Suffixes appended to the slug to identify the tier */
const APP_SUFFIX = '-app'
const AGENT_SUFFIX = '-agent'

/** How long slug->backend mappings live in the LRU cache (ms) */
const CACHE_TTL_MS = parseInt(process.env.PROXY_CACHE_TTL_MS || '30000', 10)

/** Max entries in the LRU cache */
const CACHE_MAX_SIZE = parseInt(process.env.PROXY_CACHE_MAX_SIZE || '1000', 10)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyTier = 'apps' | 'agents'

interface CacheEntry {
  target: string // e.g. "http://provider.gpu.subangle.com:31192"
  status: string // e.g. "ACTIVE"
  createdAt: number
}

interface BackendLookupResult {
  target: string | null
  status: string
  serviceId?: string
  tier: ProxyTier
}

// ---------------------------------------------------------------------------
// LRU-ish cache (Map insertion-order + TTL eviction)
// ---------------------------------------------------------------------------

class BackendCache {
  private cache = new Map<string, CacheEntry>()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key)
      return null
    }
    // Move to end (most-recently used)
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry
  }

  set(key: string, target: string, status: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { target, status, createdAt: Date.now() })
  }

  invalidate(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

// ---------------------------------------------------------------------------
// Proxy service
// ---------------------------------------------------------------------------

export class SubdomainProxy {
  private prisma: PrismaClient
  private proxy: httpProxy
  private cache: BackendCache

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
    this.cache = new BackendCache(CACHE_MAX_SIZE, CACHE_TTL_MS)

    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      // Akash providers may use self-signed certs on their ingress
      secure: false,
      // 30s timeout for Akash/Phala backends
      proxyTimeout: 30_000,
      timeout: 30_000,
      // Support WebSocket upgrades
      ws: true,
    })

    this.proxy.on('error', (err, req, res) => {
      console.error('[SubdomainProxy] Backend error:', err.message)
      if (res && 'writeHead' in res && !res.headersSent) {
        ;(res as ServerResponse).writeHead(502, { 'Content-Type': 'application/json' })
        ;(res as ServerResponse).end(JSON.stringify({
          error: 'Bad Gateway',
          message: 'The upstream service is unavailable.',
        }))
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check if the incoming request is for a proxied subdomain.
   *
   * Pattern: {slug}-app.alternatefutures.ai  or  {slug}-agent.alternatefutures.ai
   *
   * Returns the tier and slug, or null if this request is not for us.
   */
  parseSubdomain(host: string): { tier: ProxyTier; slug: string } | null {
    const h = host.toLowerCase().replace(/:\d+$/, '') // strip port

    // Must be a subdomain of BASE_DOMAIN
    if (!h.endsWith(`.${BASE_DOMAIN}`)) return null

    // Extract the subdomain part (e.g. "nanobot-app" from "nanobot-app.alternatefutures.ai")
    const sub = h.slice(0, -(BASE_DOMAIN.length + 1))

    // Must be a single-level subdomain (no dots) and non-empty
    if (!sub || sub.includes('.')) return null

    // Check for -app / -agent suffix
    if (sub.endsWith(APP_SUFFIX)) {
      const slug = sub.slice(0, -APP_SUFFIX.length)
      if (slug) return { tier: 'apps', slug }
    }

    if (sub.endsWith(AGENT_SUFFIX)) {
      const slug = sub.slice(0, -AGENT_SUFFIX.length)
      if (slug) return { tier: 'agents', slug }
    }

    return null
  }

  /**
   * Handle an HTTP request by proxying it to the correct backend.
   * Returns true if the request was handled, false if not a proxied subdomain.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const host = req.headers.host || ''
    const parsed = this.parseSubdomain(host)
    if (!parsed) return false

    const { tier, slug } = parsed
    const cacheKey = `${tier}:${slug}`

    // Check cache first
    let cached = this.cache.get(cacheKey)
    if (!cached) {
      const lookup = await this.lookupBackend(slug, tier)
      if (lookup.target) {
        this.cache.set(cacheKey, lookup.target, lookup.status)
        cached = this.cache.get(cacheKey)
      } else {
        this.sendError(res, lookup)
        return true
      }
    }

    if (!cached) {
      this.sendError(res, { target: null, status: 'NOT_FOUND', tier })
      return true
    }

    // Add forwarding headers
    req.headers['x-forwarded-host'] = host
    req.headers['x-forwarded-proto'] = 'https'
    req.headers['x-af-tier'] = tier
    req.headers['x-af-slug'] = slug

    this.proxy.web(req, res, { target: cached.target })
    return true
  }

  /**
   * Handle a WebSocket upgrade for proxied subdomains.
   * Returns true if handled.
   */
  async handleUpgrade(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const host = req.headers.host || ''
    const parsed = this.parseSubdomain(host)
    if (!parsed) return false

    const { tier, slug } = parsed
    const cacheKey = `${tier}:${slug}`

    let cached = this.cache.get(cacheKey)
    if (!cached) {
      const lookup = await this.lookupBackend(slug, tier)
      if (lookup.target) {
        this.cache.set(cacheKey, lookup.target, lookup.status)
        cached = this.cache.get(cacheKey)
      }
    }

    if (!cached) {
      socket.destroy()
      return true
    }

    this.proxy.ws(req, socket, head, { target: cached.target })
    return true
  }

  /** Invalidate cache for a specific slug (call after deployment changes) */
  invalidateSlug(slug: string, tier?: ProxyTier): void {
    if (tier) {
      this.cache.invalidate(`${tier}:${slug}`)
    } else {
      this.cache.invalidate(`apps:${slug}`)
      this.cache.invalidate(`agents:${slug}`)
    }
  }

  /** Flush entire cache */
  flushCache(): void {
    this.cache.clear()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Look up the Akash or Phala backend URL for a given slug.
   *
   * Priority:
   *   1. Active AkashDeployment with serviceUrls
   *   2. Active PhalaDeployment with appUrl
   */
  private async lookupBackend(slug: string, tier: ProxyTier): Promise<BackendLookupResult> {
    try {
      // Find the service by slug
      const service = await this.prisma.service.findFirst({
        where: { slug },
        select: {
          id: true,
          type: true,
          akashDeployments: {
            where: { status: 'ACTIVE' },
            orderBy: { deployedAt: 'desc' },
            take: 1,
            select: { serviceUrls: true, status: true },
          },
          phalaDeployments: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { appUrl: true, status: true },
          },
        },
      })

      if (!service) {
        return { target: null, status: 'NOT_FOUND', tier }
      }

      // Try Akash first
      const akashDep = service.akashDeployments[0]
      if (akashDep?.serviceUrls) {
        const urls = akashDep.serviceUrls as Record<string, { uris?: string[] }>
        const firstService = Object.values(urls)[0]
        const uri = firstService?.uris?.[0]
        if (uri) {
          // Akash URIs look like "provider.gpu.subangle.com:31192"
          // Ensure it has a protocol prefix
          const target = uri.startsWith('http') ? uri : `http://${uri}`
          return { target, status: 'ACTIVE', serviceId: service.id, tier }
        }
      }

      // Try Phala
      const phalaDep = service.phalaDeployments[0]
      if (phalaDep?.appUrl) {
        const target = phalaDep.appUrl.startsWith('http')
          ? phalaDep.appUrl
          : `https://${phalaDep.appUrl}`
        return { target, status: 'ACTIVE', serviceId: service.id, tier }
      }

      // Deployment exists but URIs not yet available (provider still setting up ingress)
      if (akashDep || phalaDep) {
        return { target: null, status: 'PROVISIONING', serviceId: service.id, tier }
      }

      // Service exists but no active deployment at all
      return { target: null, status: 'NO_ACTIVE_DEPLOYMENT', serviceId: service.id, tier }
    } catch (err) {
      console.error('[SubdomainProxy] DB lookup error:', err)
      return { target: null, status: 'INTERNAL_ERROR', tier }
    }
  }

  private sendError(res: ServerResponse, lookup: BackendLookupResult): void {
    const { status, tier } = lookup

    switch (status) {
      case 'NOT_FOUND':
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'Not Found',
          message: `No service found for this ${tier === 'agents' ? 'agent' : 'app'} subdomain.`,
        }))
        break

      case 'PROVISIONING':
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '15',
        })
        res.end(JSON.stringify({
          error: 'Provisioning',
          message: 'Your deployment is active but the URL is still being set up. Please refresh in a few seconds.',
        }))
        break

      case 'NO_ACTIVE_DEPLOYMENT':
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'Service Unavailable',
          message: 'This service exists but has no active deployment.',
        }))
        break

      case 'INTERNAL_ERROR':
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'Bad Gateway',
          message: 'An internal error occurred while routing your request.',
        }))
        break

      default:
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown Error' }))
    }
  }
}
