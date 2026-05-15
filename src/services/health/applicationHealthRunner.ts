/**
 * Application Health Runner.
 *
 * Walks every Service with a `healthProbe` configured and an ACTIVE
 * deployment (Akash, Phala, or Spheron), fires HTTP probes, stores the
 * last 20 results per service, and exposes them via
 * `Service.applicationHealth` for the dashboard badge + timeline.
 *
 * Distinct from provider `getHealth` (replica count); this checks whether
 * the *application* responds — useful for hung/panicked processes or wrong
 * port. One 30s tick scheduler with per-probe interval throttling and
 * AbortController-cancelled fetches. Results are in-memory; the audit log
 * captures state-flips for persistence.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'

const log = createLogger('app-health-runner')

const TICK_MS = 30_000
const RESULTS_PER_SERVICE = 20

const DEFAULTS = {
  path: '/',
  expectStatus: 200,
  intervalSec: 30,
  timeoutSec: 5,
} as const

const MIN_INTERVAL_SEC = 10
const MAX_INTERVAL_SEC = 3600
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 30

export interface HealthProbeConfig {
  path: string
  port?: number
  expectStatus?: number
  intervalSec?: number
  timeoutSec?: number
}

export interface ProbeResult {
  timestamp: Date
  ok: boolean
  statusCode?: number
  latencyMs: number
  error?: string
}

export interface ProbeSnapshot {
  results: ProbeResult[]
  lastChecked: Date | null
}

export type ApplicationOverallHealth = 'healthy' | 'unhealthy' | 'starting' | 'unknown'

interface RunnerDeps {
  /** Mockable fetch — tests inject a stub instead of real HTTP. */
  fetchFn?: typeof fetch
  /** Tick interval; tests override to drive the loop synchronously. */
  tickMs?: number
}

/**
 * Singleton-ish runner. We export a default instance for production wiring
 * (started from `src/index.ts`) and the class itself for tests that want
 * fully isolated state.
 */
export class ApplicationHealthRunner {
  private snapshots = new Map<string, ProbeSnapshot>()
  private inflight = new Map<string, AbortController>()
  private interval: ReturnType<typeof setInterval> | null = null
  private prisma: PrismaClient | null = null
  private readonly fetchFn: typeof fetch
  private readonly tickMs: number
  private tickInProgress = false

  constructor(deps: RunnerDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch
    this.tickMs = deps.tickMs ?? TICK_MS
  }

  start(prisma: PrismaClient): void {
    if (this.interval) return
    this.prisma = prisma
    this.interval = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    void this.tick()
    log.info({ tickMs: this.tickMs }, 'Application health runner started')
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    for (const controller of this.inflight.values()) {
      try { controller.abort() } catch { /* noop */ }
    }
    this.inflight.clear()
    log.info('Application health runner stopped')
  }

  /** Read-only snapshot for the GraphQL resolver. */
  getSnapshot(serviceId: string): ProbeSnapshot | null {
    return this.snapshots.get(serviceId) ?? null
  }

  /** Aggregate the last results into an overall status. */
  getOverall(serviceId: string): ApplicationOverallHealth {
    const snap = this.snapshots.get(serviceId)
    if (!snap || snap.results.length === 0) return 'unknown'
    const last3 = snap.results.slice(-3)
    if (last3.every(r => r.ok)) return 'healthy'
    if (last3.every(r => !r.ok)) return 'unhealthy'
    return 'starting'
  }

  /** Force a single probe immediately. Used by tests + smoke scripts. */
  async probeOnce(args: {
    serviceId: string
    uri: string
    probe: HealthProbeConfig
  }): Promise<ProbeResult> {
    const result = await this.runProbe(args.uri, this.normalize(args.probe))
    this.recordResult(args.serviceId, result, args.probe)
    return result
  }

  // ──────────────────────────────────────────────────────────────────
  // internals
  // ──────────────────────────────────────────────────────────────────

  /**
   * One scheduler pass. Re-entrancy guard prevents two ticks from
   * overlapping if the underlying DB query gets slow.
   */
  private async tick(): Promise<void> {
    if (this.tickInProgress || !this.prisma) return
    this.tickInProgress = true
    try {
      const candidates = await this.loadCandidates(this.prisma)
      const now = Date.now()
      await Promise.all(
        candidates.map(async (c) => {
          const probe = this.normalize(c.probe)
          const snap = this.snapshots.get(c.serviceId)
          if (snap?.lastChecked) {
            const elapsedSec = (now - snap.lastChecked.getTime()) / 1000
            if (elapsedSec < probe.intervalSec) return
          }
          const result = await this.runProbe(c.uri, probe)
          this.recordResult(c.serviceId, result, c.probe)
        })
      )
    } catch (err) {
      log.warn({ err }, 'Application health tick failed')
    } finally {
      this.tickInProgress = false
    }
  }

  /**
   * Find every service with a configured probe and an ACTIVE deployment on
   * any provider that exposes a URI we can reach. Akash → `serviceUrls`
   * (provider-side global URIs), Phala → `appUrl`, Spheron → `ipAddress`
   * + first port from the service's port table.
   */
  private async loadCandidates(prisma: PrismaClient): Promise<Array<{
    serviceId: string
    uri: string
    probe: HealthProbeConfig
  }>> {
    // `Prisma.JsonNull` sentinel matches DB-NULL exactly; `NOT: { equals: JsonNull }`
    // returns services with a healthProbe configured.
    const services = await prisma.service.findMany({
      where: {
        NOT: { healthProbe: { equals: Prisma.JsonNull } },
      },
      select: {
        id: true,
        sdlServiceName: true,
        containerPort: true,
        healthProbe: true,
        ports: {
          select: { containerPort: true, publicPort: true },
          orderBy: { containerPort: 'asc' },
          take: 1,
        },
        akashDeployments: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { serviceUrls: true },
        },
        phalaDeployments: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { appUrl: true },
        },
        spheronDeployments: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { ipAddress: true },
        },
      },
    })

    const out: Array<{ serviceId: string; uri: string; probe: HealthProbeConfig }> = []
    for (const svc of services) {
      const probe = this.coerceProbe(svc.healthProbe)
      if (!probe) continue

      let uri: string | null = null
      const akash = svc.akashDeployments[0]
      if (akash) {
        uri = pickProbeUri(akash.serviceUrls, svc.sdlServiceName, probe.port)
      }
      if (!uri) {
        const phala = svc.phalaDeployments[0]
        if (phala?.appUrl) uri = phala.appUrl
      }
      if (!uri) {
        const spheron = svc.spheronDeployments[0]
        if (spheron?.ipAddress) {
          const port = probe.port
            ?? svc.ports[0]?.publicPort
            ?? svc.ports[0]?.containerPort
            ?? svc.containerPort
            ?? 80
          uri = `${spheron.ipAddress}:${port}`
        }
      }
      if (!uri) continue
      out.push({ serviceId: svc.id, uri, probe })
    }
    return out
  }

  private async runProbe(uri: string, probe: Required<Omit<HealthProbeConfig, 'port'>> & { port?: number }): Promise<ProbeResult> {
    const url = buildProbeUrl(uri, probe.path)
    if (!url) {
      return {
        timestamp: new Date(),
        ok: false,
        latencyMs: 0,
        error: `Could not derive probe URL from URI ${uri}`,
      }
    }

    const controller = new AbortController()
    const tag = `${url.toString()}#${Date.now()}`
    this.inflight.set(tag, controller)
    const timer = setTimeout(() => controller.abort(), probe.timeoutSec * 1000)
    const startedAt = Date.now()

    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        signal: controller.signal,
        // Health probes never need cookies, redirects, or response bodies.
        // We close the connection eagerly so we don't keep sockets open.
        redirect: 'manual',
      })
      const latencyMs = Date.now() - startedAt
      // Drain (and discard) the body so the underlying socket is released
      // for the next probe cycle. `arrayBuffer()` is safe even on 5xx.
      try { await res.arrayBuffer() } catch { /* ignore */ }
      const ok = res.status === probe.expectStatus
      return { timestamp: new Date(), ok, statusCode: res.status, latencyMs }
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      const e = err as Error & { name?: string }
      const isAbort = e.name === 'AbortError'
      return {
        timestamp: new Date(),
        ok: false,
        latencyMs,
        error: isAbort ? `Timed out after ${probe.timeoutSec}s` : (e.message || String(err)),
      }
    } finally {
      clearTimeout(timer)
      this.inflight.delete(tag)
    }
  }

  private recordResult(serviceId: string, result: ProbeResult, probe: HealthProbeConfig): void {
    const existing = this.snapshots.get(serviceId)
    const previousOverall = existing ? this.deriveOverall(existing.results) : 'unknown'
    const nextResults = [...(existing?.results ?? []), result].slice(-RESULTS_PER_SERVICE)
    const next: ProbeSnapshot = { results: nextResults, lastChecked: result.timestamp }
    this.snapshots.set(serviceId, next)

    const newOverall = this.deriveOverall(nextResults)
    if (newOverall !== previousOverall && previousOverall !== 'unknown' && this.prisma) {
      // Audit on state transitions only — every-tick spam would drown the log.
      audit(this.prisma, {
        action: newOverall === 'healthy' ? 'app_health.recovered' : 'app_health.degraded',
        category: 'health',
        status: newOverall === 'healthy' ? 'ok' : 'error',
        serviceId,
        payload: {
          from: previousOverall,
          to: newOverall,
          probe: { path: probe.path, port: probe.port ?? null },
          lastResult: {
            ok: result.ok,
            statusCode: result.statusCode ?? null,
            latencyMs: result.latencyMs,
            error: result.error ?? null,
          },
        },
      })
    }
  }

  private deriveOverall(results: ProbeResult[]): ApplicationOverallHealth {
    if (results.length === 0) return 'unknown'
    const last3 = results.slice(-3)
    if (last3.every(r => r.ok)) return 'healthy'
    if (last3.every(r => !r.ok)) return 'unhealthy'
    return 'starting'
  }

  private coerceProbe(raw: unknown): HealthProbeConfig | null {
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const path = typeof obj.path === 'string' ? obj.path : DEFAULTS.path
    if (!path.startsWith('/')) return null
    const probe: HealthProbeConfig = { path }
    if (typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0 && obj.port <= 65535) {
      probe.port = obj.port
    }
    if (typeof obj.expectStatus === 'number' && Number.isInteger(obj.expectStatus) && obj.expectStatus >= 100 && obj.expectStatus <= 599) {
      probe.expectStatus = obj.expectStatus
    }
    if (typeof obj.intervalSec === 'number' && Number.isInteger(obj.intervalSec)) {
      probe.intervalSec = clamp(obj.intervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
    }
    if (typeof obj.timeoutSec === 'number' && Number.isInteger(obj.timeoutSec)) {
      probe.timeoutSec = clamp(obj.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC)
    }
    return probe
  }

  private normalize(probe: HealthProbeConfig): Required<Omit<HealthProbeConfig, 'port'>> & { port?: number } {
    return {
      path: probe.path,
      port: probe.port,
      expectStatus: probe.expectStatus ?? DEFAULTS.expectStatus,
      intervalSec: clamp(probe.intervalSec ?? DEFAULTS.intervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
      timeoutSec: clamp(probe.timeoutSec ?? DEFAULTS.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC),
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// URI helpers (exported for the smoke test)
// ──────────────────────────────────────────────────────────────────

export function pickProbeUri(
  serviceUrls: unknown,
  preferredService: string | null,
  portOverride?: number,
): string | null {
  if (!serviceUrls || typeof serviceUrls !== 'object') return null
  const entries = serviceUrls as Record<string, { uris?: string[] }>
  const orderedKeys = preferredService && entries[preferredService]
    ? [preferredService, ...Object.keys(entries).filter(k => k !== preferredService)]
    : Object.keys(entries)

  for (const key of orderedKeys) {
    const uris = entries[key]?.uris
    if (!Array.isArray(uris) || uris.length === 0) continue
    const raw = uris[0]
    if (!raw || typeof raw !== 'string') continue
    return applyPortOverride(raw, portOverride) ?? raw
  }
  return null
}

function applyPortOverride(uri: string, port?: number): string | null {
  if (!port) return uri
  // Forwarded-port form: "host:port" (no scheme)
  if (!uri.includes('://')) {
    const idx = uri.lastIndexOf(':')
    const host = idx > 0 ? uri.slice(0, idx) : uri
    return `${host}:${port}`
  }
  try {
    const u = new URL(uri)
    u.port = String(port)
    return u.toString().replace(/\/$/, '')
  } catch {
    return uri
  }
}

export function buildProbeUrl(uri: string, path: string): URL | null {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  try {
    if (uri.includes('://')) {
      const base = new URL(uri)
      // Replace the path entirely — never compose user paths with the URI
      // the provider returned (host might already carry a path).
      return new URL(normalizedPath, `${base.protocol}//${base.host}`)
    }
    // host:port form (forwarded ports). Default to http — TLS rarely
    // terminates on raw forwarded ports.
    return new URL(normalizedPath, `http://${uri}`)
  } catch {
    return null
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

// ──────────────────────────────────────────────────────────────────
// Default singleton (production wiring lives in src/index.ts)
// ──────────────────────────────────────────────────────────────────

let defaultRunner: ApplicationHealthRunner | null = null

export function getApplicationHealthRunner(): ApplicationHealthRunner {
  if (!defaultRunner) defaultRunner = new ApplicationHealthRunner()
  return defaultRunner
}

export function startApplicationHealthRunner(prisma: PrismaClient): ApplicationHealthRunner {
  const runner = getApplicationHealthRunner()
  runner.start(prisma)
  return runner
}

export function stopApplicationHealthRunner(): void {
  defaultRunner?.stop()
}
