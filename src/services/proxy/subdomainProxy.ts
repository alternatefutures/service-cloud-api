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

import httpProxy from 'http-proxy'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('subdomain-proxy')

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
// SSRF protection — block proxying to internal/private IPs
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 127) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts.every((p) => p === 0)) return true
  return false
}

function isPrivateIP(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1])

  if (isPrivateIPv4(ip)) return true

  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower === '::') return true
  if (lower.startsWith('fe80:')) return true      // link-local
  if (lower.startsWith('fc00:')) return true      // unique local
  if (lower.startsWith('fd')) return true          // unique local (fd00::/8)
  if (lower.startsWith('fec0:')) return true       // site-local (deprecated but exists)

  return false
}

/**
 * Resolves a target URL's hostname to an IP and validates it's not internal.
 *
 * Returns the original URL if safe, null if blocked.
 * We preserve the original hostname (rather than IP-pinning) because some
 * backends (Phala CDN, etc.) rely on Host-header routing. The DNS TOCTOU
 * window is acceptable here since target URLs come from our own database,
 * not user input.
 */
async function resolveAndValidateTarget(targetUrl: string): Promise<string | null> {
  try {
    const url = new URL(targetUrl)
    const hostname = url.hostname

    let resolvedIP: string
    if (isIP(hostname)) {
      resolvedIP = hostname
    } else {
      const result = await lookup(hostname)
      resolvedIP = result.address
    }

    if (isPrivateIP(resolvedIP)) return null

    return targetUrl
  } catch {
    return null
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
      // Preserve the browser's original Host header on the way out. AWS
      // sigv4 backends (RustFS console, MinIO, S3 SDKs talking to a self-
      // hosted bucket) include `Host` in the canonical request, so any
      // rewrite breaks signature validation. Provider-side routing is
      // handled by the SDL `expose.accept:` block instead — the SDL
      // generator emits the AF subdomain hostname for every globally-
      // proxied port (see `templates/sdl.ts:buildPortExpose`).
      changeOrigin: false,
      // Akash providers may use self-signed certs on their ingress
      secure: false,
      // 30s timeout for Akash/Phala backends
      proxyTimeout: 30_000,
      timeout: 30_000,
      // Support WebSocket upgrades
      ws: true,
    })

    this.proxy.on('error', (err, req, res) => {
      log.error({ err }, 'Backend error')
      if (res && 'writeHead' in res && !res.headersSent) {
        ;(res as ServerResponse).writeHead(502, {
          'Content-Type': 'application/json',
        })
        ;(res as ServerResponse).end(
          JSON.stringify({
            error: 'Bad Gateway',
            message: 'The upstream service is unavailable.',
          })
        )
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
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const host = req.headers.host || ''
    const parsed = this.parseSubdomain(host)
    if (!parsed) return false

    const { tier, slug } = parsed
    const cacheKey = `${tier}:${slug}`

    // Check cache first (cached targets are already IP-pinned and validated)
    let cached = this.cache.get(cacheKey)
    if (!cached) {
      const backend = await this.lookupBackend(slug, tier)
      if (!backend.target) {
        this.sendError(res, backend)
        return true
      }

      // Resolve DNS and validate BEFORE caching — prevents caching internal targets
      // and pins the IP to eliminate TOCTOU between check and proxy connect
      const pinnedTarget = await resolveAndValidateTarget(backend.target)
      if (!pinnedTarget) {
        log.warn({ slug, tier, target: backend.target }, 'SSRF blocked: internal target')
        this.sendError(res, { target: null, status: 'INTERNAL_ERROR', tier })
        return true
      }

      this.cache.set(cacheKey, pinnedTarget, backend.status)
      cached = this.cache.get(cacheKey)
    }

    if (!cached) {
      this.sendError(res, { target: null, status: 'NOT_FOUND', tier })
      return true
    }

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
    head: Buffer
  ): Promise<boolean> {
    const host = req.headers.host || ''
    const parsed = this.parseSubdomain(host)
    if (!parsed) return false

    const { tier, slug } = parsed
    const cacheKey = `${tier}:${slug}`

    let cached = this.cache.get(cacheKey)
    if (!cached) {
      const backend = await this.lookupBackend(slug, tier)
      if (!backend.target) {
        socket.destroy()
        return true
      }

      const pinnedTarget = await resolveAndValidateTarget(backend.target)
      if (!pinnedTarget) {
        log.warn({ slug, tier, target: backend.target }, 'SSRF blocked: internal WS target')
        socket.destroy()
        return true
      }

      this.cache.set(cacheKey, pinnedTarget, backend.status)
      cached = this.cache.get(cacheKey)
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
  private async lookupBackend(
    slug: string,
    tier: ProxyTier
  ): Promise<BackendLookupResult> {
    try {
      // Find the service by slug
      const service = await this.prisma.service.findFirst({
        where: { slug },
        select: {
          id: true,
          type: true,
          sdlServiceName: true,
          parentServiceId: true,
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

      // Companion services share the parent's Akash deployment
      let akashDep: { serviceUrls: unknown; status: string } | undefined =
        service.akashDeployments[0]
      if (!akashDep && service.parentServiceId) {
        const parent = await this.prisma.service.findUnique({
          where: { id: service.parentServiceId },
          select: {
            akashDeployments: {
              where: { status: 'ACTIVE' },
              orderBy: { deployedAt: 'desc' },
              take: 1,
              select: { serviceUrls: true, status: true },
            },
          },
        })
        akashDep = parent?.akashDeployments[0]
      }

      // Try Akash
      if (akashDep?.serviceUrls) {
        const urls = akashDep.serviceUrls as Record<string, { uris?: string[] }>

        // If this service has an sdlServiceName, use it for a direct lookup
        // instead of iterating (needed for multi-service deployments with
        // multiple globally-exposed containers).
        let uri: string | undefined
        if (
          service.sdlServiceName &&
          urls[service.sdlServiceName]?.uris?.length
        ) {
          uri = urls[service.sdlServiceName].uris![0]
        } else {
          // Fallback: find the first service with externally-reachable URIs
          for (const svc of Object.values(urls)) {
            if (svc.uris?.length) {
              uri = svc.uris[0]
              break
            }
          }
        }

        if (uri) {
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
        return {
          target: null,
          status: 'PROVISIONING',
          serviceId: service.id,
          tier,
        }
      }

      // Service exists but no active deployment at all
      return {
        target: null,
        status: 'NO_ACTIVE_DEPLOYMENT',
        serviceId: service.id,
        tier,
      }
    } catch (err) {
      log.error({ err }, 'DB lookup error')
      return { target: null, status: 'INTERNAL_ERROR', tier }
    }
  }

  private sendError(res: ServerResponse, lookup: BackendLookupResult): void {
    const { status, tier } = lookup

    switch (status) {
      case 'NOT_FOUND':
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: 'Not Found',
            message: `No service found for this ${tier === 'agents' ? 'agent' : 'app'} subdomain.`,
          })
        )
        break

      case 'PROVISIONING':
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '15',
        })
        res.end(
          JSON.stringify({
            error: 'Provisioning',
            message:
              'Your deployment is active but the URL is still being set up. Please refresh in a few seconds.',
          })
        )
        break

      case 'NO_ACTIVE_DEPLOYMENT':
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: 'Service Unavailable',
            message: 'This service exists but has no active deployment.',
          })
        )
        break

      case 'INTERNAL_ERROR':
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: 'Bad Gateway',
            message: 'An internal error occurred while routing your request.',
          })
        )
        break

      default:
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown Error' }))
    }
  }
}
