/**
 * Internal endpoint: GET /internal/admin/audit-events  (Phase 44 / D3b)
 *
 * Live admin query against the unified audit log. UNIONs the cloud-api
 * half (this service's Postgres) with the auth half (fetched via
 * service-auth's `/internal/audit/range`) at request time.
 *
 * Why a fresh endpoint instead of reusing the JSONL exporter:
 *   - This is for UI consumption (small windows, filtered queries),
 *     not bulk export. A nightly JSONL would force the admin UI to
 *     wait until tomorrow to see today's events.
 *   - The filter shape (userId / orgId / action / status / traceId)
 *     pushes down into Postgres + the auth /range endpoint as
 *     query params, so we never pull the full day.
 *
 * Auth: `INTERNAL_AUTH_TOKEN` on `x-internal-auth` (same pattern as
 * billing-stats / deployment-stats). The web-app-admin Next.js app
 * sits behind its own admin-cookie session and proxies through to
 * this endpoint server-side, so the token never reaches the browser.
 *
 * Response: JSON envelope (NOT NDJSON — the admin UI wants typed
 * fields, total counts, and side-of-origin metadata).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient, Prisma } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { currentTraceId } from '../../lib/audit.js'

const log = createLogger('admin-audit-events')

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:1601'
const INTROSPECTION_SECRET = process.env.AUTH_INTROSPECTION_SECRET || ''

// Hard cap on the per-request window. The endpoint pulls all matching
// rows from BOTH halves into memory before merging; without this an
// admin asking for "last year, no filters" would OOM the pod.
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

// Hard cap on the lookback window. 30 days is generous for "what
// went wrong this week" queries; longer ranges should hit the JSONL
// archive instead.
const MAX_WINDOW_DAYS = 30

interface AuditEventRow {
  id: string
  timestamp: string
  traceId: string
  source: string
  category: string
  action: string
  status: string
  userId: string | null
  orgId: string | null
  projectId: string | null
  serviceId: string | null
  deploymentId: string | null
  durationMs: number | null
  payload: unknown
  errorCode: string | null
  errorMessage: string | null
}

interface ResponseBody {
  events: AuditEventRow[]
  count: number
  /**
   * `true` if either half was truncated by the per-side limit. Tells
   * the UI to show a "narrow your filter" hint rather than implying
   * the result is exhaustive.
   */
  truncated: boolean
  /** Per-side counts so we can spot if one DB is silent (= broken). */
  cloudApiCount: number
  authCount: number
  /** Echo back the resolved filter so the UI can render what it asked for. */
  filter: {
    from: string
    to: string
    userId: string | null
    orgId: string | null
    action: string | null
    status: string | null
    traceId: string | null
    source: string | null
    limit: number
  }
}

export async function handleAdminAuditEvents(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient,
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']
  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const filter = parseFilter(url.searchParams)
    if ('error' in filter) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: filter.error }))
      return
    }

    const [cloudRows, authRows] = await Promise.all([
      fetchCloudApiSide(prisma, filter),
      fetchAuthSide(filter),
    ])

    const merged = mergeDescending(cloudRows, authRows).slice(0, filter.limit)

    const body: ResponseBody = {
      events: merged,
      count: merged.length,
      truncated: cloudRows.length === filter.limit || authRows.length === filter.limit,
      cloudApiCount: cloudRows.length,
      authCount: authRows.length,
      filter: {
        from: filter.from.toISOString(),
        to: filter.to.toISOString(),
        userId: filter.userId,
        orgId: filter.orgId,
        action: filter.action,
        status: filter.status,
        traceId: filter.traceId,
        source: filter.source,
        limit: filter.limit,
      },
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  } catch (err) {
    log.error({ err }, 'Audit events query failed')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal error', message: (err as Error).message }))
  }
}

// ─────────────────────────────────────────────────────────────────────
// Filter parsing
// ─────────────────────────────────────────────────────────────────────

interface ParsedFilter {
  from: Date
  to: Date
  userId: string | null
  orgId: string | null
  action: string | null
  status: string | null
  traceId: string | null
  /** `auth` | `cloud-api` | `cron` | `monitor` — narrows which half to query. */
  source: string | null
  limit: number
}

function parseFilter(q: URLSearchParams): ParsedFilter | { error: string } {
  // Default window: last 24 hours. Admin pages that want a narrower
  // slice pass explicit `from`/`to`.
  const now = Date.now()
  const fromStr = q.get('from')
  const toStr = q.get('to')
  const from = fromStr ? new Date(fromStr) : new Date(now - 24 * 60 * 60 * 1000)
  const to = toStr ? new Date(toStr) : new Date(now)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'Invalid from/to (expected ISO8601)' }
  }
  if (to <= from) return { error: '`to` must be after `from`' }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return { error: `Window exceeds MAX_WINDOW_DAYS (${MAX_WINDOW_DAYS})` }
  }

  const limitParam = Number(q.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, Math.floor(limitParam)), MAX_LIMIT)
    : DEFAULT_LIMIT

  return {
    from,
    to,
    userId: nullableTrim(q.get('userId')),
    orgId: nullableTrim(q.get('orgId')),
    action: nullableTrim(q.get('action')),
    status: nullableTrim(q.get('status')),
    traceId: nullableTrim(q.get('traceId')),
    source: nullableTrim(q.get('source')),
    limit,
  }
}

function nullableTrim(s: string | null): string | null {
  if (s === null) return null
  const trimmed = s.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ─────────────────────────────────────────────────────────────────────
// Fetchers
// ─────────────────────────────────────────────────────────────────────

async function fetchCloudApiSide(
  prisma: PrismaClient,
  f: ParsedFilter,
): Promise<AuditEventRow[]> {
  // Skip the cloud-api half entirely if the caller pinned the source
  // to something else — saves a query on a known-empty half.
  if (f.source && f.source !== 'cloud-api' && f.source !== 'cron' && f.source !== 'monitor') {
    return []
  }

  const where: Prisma.AuditEventWhereInput = {
    timestamp: { gte: f.from, lt: f.to },
  }
  if (f.userId) where.userId = f.userId
  if (f.orgId) where.orgId = f.orgId
  if (f.action) where.action = { contains: f.action, mode: 'insensitive' }
  if (f.status) where.status = f.status
  if (f.traceId) where.traceId = f.traceId
  if (f.source) where.source = f.source

  // DESC because the UI wants newest first. We over-fetch by `limit`
  // per-side so the merge has enough to pick from; the caller slices
  // back down to `limit` after the merge.
  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    take: f.limit,
  })

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp.toISOString(),
    traceId: r.traceId,
    source: r.source,
    category: r.category,
    action: r.action,
    status: r.status,
    userId: r.userId,
    orgId: r.orgId,
    projectId: r.projectId,
    serviceId: r.serviceId,
    deploymentId: r.deploymentId,
    durationMs: r.durationMs,
    payload: r.payload,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
  }))
}

async function fetchAuthSide(f: ParsedFilter): Promise<AuditEventRow[]> {
  // Caller pinned to a non-auth source, or no introspection secret →
  // skip the auth half. Same reasoning as the cloud-api skip above.
  if (f.source && f.source !== 'auth') return []
  if (!INTROSPECTION_SECRET) {
    log.warn('AUTH_INTROSPECTION_SECRET not set — auth side of audit query is empty')
    return []
  }

  // The /range endpoint doesn't (yet) accept these filters server-side,
  // so we pull the window then filter in-process. Acceptable while the
  // window is hard-capped at 30d × 500 rows; if either grows, push the
  // filters down into the route in a follow-up.
  const url = new URL(`${AUTH_SERVICE_URL}/internal/audit/range`)
  url.searchParams.set('from', f.from.toISOString())
  url.searchParams.set('to', f.to.toISOString())
  url.searchParams.set('limit', String(f.limit))

  const res = await fetch(url, {
    headers: {
      'x-af-introspection-secret': INTROSPECTION_SECRET,
      'x-af-trace-id': currentTraceId(),
    },
  })
  if (!res.ok) {
    throw new Error(
      `auth /internal/audit/range failed: ${res.status} ${res.statusText} — ` +
        (await res.text().catch(() => '<unreadable>'))
    )
  }

  const body = await res.text()
  if (!body) return []

  const rows = body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEventRow)

  // /range returns ASC by (timestamp, id) — that's the right order
  // for the JSONL exporter's stable merge but the WRONG order for
  // this admin endpoint, which wants newest-first. Reverse here so
  // mergeDescending() below stays a vanilla 2-way merge.
  rows.reverse()

  // Apply filters in-process. Cheap at ≤500 rows per page.
  return rows.filter((r) => {
    if (f.userId && r.userId !== f.userId) return false
    if (f.orgId && r.orgId !== f.orgId) return false
    if (f.action && !r.action.toLowerCase().includes(f.action.toLowerCase())) return false
    if (f.status && r.status !== f.status) return false
    if (f.traceId && r.traceId !== f.traceId) return false
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────
// Merge — newest-first across both halves
// ─────────────────────────────────────────────────────────────────────

function mergeDescending(a: AuditEventRow[], b: AuditEventRow[]): AuditEventRow[] {
  // Both inputs come back DESC by (timestamp, id). Standard 2-way
  // merge with the comparator inverted.
  const out: AuditEventRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i].timestamp > b[j].timestamp) out.push(a[i++])
    else if (a[i].timestamp < b[j].timestamp) out.push(b[j++])
    else if (a[i].id > b[j].id) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}
