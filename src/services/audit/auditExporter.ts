/**
 * Audit Log JSONL Exporter (Phase 44 / D3a)
 *
 * Pulls a UTC day's audit events from BOTH `service-auth` and
 * `service-cloud-api`, merges them by `(timestamp, id)`, writes one
 * `.jsonl` file. The output file is the primary deliverable for
 * "audit a week of data and find inconsistencies" — every consumer
 * (admin grep, BigQuery import, Pandas notebook) reads from this.
 *
 * Where files land
 *   default: `<AUDIT_EXPORT_DIR>/YYYY/MM/YYYY-MM-DD.jsonl`
 *   env override: `AUDIT_EXPORT_DIR` (defaults to `./audit-exports`)
 *
 * S3 / object-store upload is deliberately deferred — local disk on
 * the cloud-api pod (mounted on a persistent volume in K8s) is enough
 * for the first-100-users cohort, and adding an S3 client now would
 * commit us to a credential model we may not want long-term.
 *
 * Idempotency: the writer atomically replaces an existing file for
 * the same date. Re-running a date overwrites — never appends — so
 * re-export after a fix produces the same artifact byte-for-byte
 * (modulo new rows that landed since).
 *
 * Cross-service fetch contract:
 *   GET <AUTH_SERVICE_URL>/internal/audit/range?from=...&to=...
 *   Headers:
 *     x-af-introspection-secret: AUTH_INTROSPECTION_SECRET
 *     x-af-trace-id:             current trace (for the fetcher's own logs)
 *   Response: NDJSON body, pagination via `x-af-audit-*` headers.
 */

import type { PrismaClient } from '@prisma/client'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../lib/logger.js'
import { currentTraceId } from '../../lib/audit.js'

const log = createLogger('audit-exporter')

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:1601'
const INTROSPECTION_SECRET = process.env.AUTH_INTROSPECTION_SECRET || ''
const EXPORT_DIR = process.env.AUDIT_EXPORT_DIR || path.resolve(process.cwd(), 'audit-exports')

export interface AuditExportRow {
  id: string
  timestamp: string                    // ISO8601 — string-comparable for merge
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

export interface ExportResult {
  date: string                         // YYYY-MM-DD (UTC)
  filePath: string
  cloudApiCount: number
  authCount: number
  totalCount: number
  bytes: number
  durationMs: number
}

/**
 * Export one UTC day. `date` may be a Date (treated as the UTC day it
 * falls in) or a YYYY-MM-DD string.
 *
 * Idempotent — re-running clobbers the existing file via atomic rename
 * from a `.tmp` sibling (so partial writes never leave a corrupt file
 * for a downstream importer to choke on).
 */
export async function exportAuditDay(
  prisma: PrismaClient,
  date: Date | string,
): Promise<ExportResult> {
  const start = Date.now()
  const { from, to, isoDate } = utcDayRange(date)

  log.info({ isoDate, from: from.toISOString(), to: to.toISOString() }, 'Starting audit export')

  const [cloudApiRows, authRows] = await Promise.all([
    fetchCloudApiRows(prisma, from, to),
    fetchAuthRows(from, to),
  ])

  // Merge. Both inputs are already sorted by (timestamp, id) — merge
  // is therefore O(n) and stable. We do NOT dedupe across services
  // because the two `id` namespaces are disjoint by construction
  // (separate cuid generators, separate tables).
  const merged = mergeSorted(cloudApiRows, authRows)

  const filePath = await writeJsonl(isoDate, merged)
  const stat = await fs.stat(filePath)

  const result: ExportResult = {
    date: isoDate,
    filePath,
    cloudApiCount: cloudApiRows.length,
    authCount: authRows.length,
    totalCount: merged.length,
    bytes: stat.size,
    durationMs: Date.now() - start,
  }

  log.info(result, 'Audit export complete')
  return result
}

// ─────────────────────────────────────────────────────────────────────
// Internal: row fetchers
// ─────────────────────────────────────────────────────────────────────

async function fetchCloudApiRows(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<AuditExportRow[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { timestamp: { gte: from, lt: to } },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
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

async function fetchAuthRows(from: Date, to: Date): Promise<AuditExportRow[]> {
  if (!INTROSPECTION_SECRET) {
    log.warn('AUTH_INTROSPECTION_SECRET not set — skipping auth-side export')
    return []
  }

  const out: AuditExportRow[] = []
  let cursor: string | undefined
  // Page until the auth side reports no more rows. PAGE_SIZE matches
  // the endpoint's default; raising it requires also raising the
  // server-side max — keeping them coupled means perf tuning happens
  // in one place.
  const PAGE_SIZE = 1000

  for (let page = 0; page < 1000; page++) {
    const url = new URL(`${AUTH_SERVICE_URL}/internal/audit/range`)
    url.searchParams.set('from', from.toISOString())
    url.searchParams.set('to', to.toISOString())
    url.searchParams.set('limit', String(PAGE_SIZE))
    if (cursor) url.searchParams.set('cursor', cursor)

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
    if (body.length > 0) {
      for (const line of body.split('\n')) {
        if (!line) continue
        out.push(JSON.parse(line) as AuditExportRow)
      }
    }

    const hasMore = res.headers.get('x-af-audit-has-more') === '1'
    const next = res.headers.get('x-af-audit-next-cursor')
    if (!hasMore || !next) return out
    cursor = next
  }

  // Pathological case — auth keeps reporting "more" with no progress.
  // Bail loudly so we don't spin forever.
  throw new Error('auth audit pagination exceeded 1000 pages — cursor not advancing?')
}

// ─────────────────────────────────────────────────────────────────────
// Internal: merge + write
// ─────────────────────────────────────────────────────────────────────

function mergeSorted(a: AuditExportRow[], b: AuditExportRow[]): AuditExportRow[] {
  const out: AuditExportRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    // Primary order: timestamp (ISO string compare is lexically
    // correct for any RFC3339 timestamp). Tie-break on id so the
    // ordering is stable across re-runs.
    if (a[i].timestamp < b[j].timestamp) out.push(a[i++])
    else if (a[i].timestamp > b[j].timestamp) out.push(b[j++])
    else if (a[i].id < b[j].id) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

async function writeJsonl(isoDate: string, rows: AuditExportRow[]): Promise<string> {
  const [year, month] = isoDate.split('-')
  const dir = path.join(EXPORT_DIR, year, month)
  await fs.mkdir(dir, { recursive: true })

  const finalPath = path.join(dir, `${isoDate}.jsonl`)
  const tmpPath = `${finalPath}.tmp`

  // Build the full body in memory. Daily volume for the first 100
  // users is bounded — back-of-envelope: ~500 events/user/day × 100
  // users × ~1 KiB/event ≈ 50 MiB. Comfortable for in-memory; revisit
  // when daily count crosses ~5M rows.
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  await fs.writeFile(tmpPath, body, 'utf-8')
  await fs.rename(tmpPath, finalPath)

  return finalPath
}

// ─────────────────────────────────────────────────────────────────────
// Internal: date helpers
// ─────────────────────────────────────────────────────────────────────

function utcDayRange(date: Date | string): { from: Date; to: Date; isoDate: string } {
  const isoDate = typeof date === 'string' ? date : toIsoDate(date)
  // Strict YYYY-MM-DD parse so a stray "2026-04-16T12:00Z" doesn't
  // silently shift the window by 12 hours.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) throw new Error(`exportAuditDay: bad date "${isoDate}" — expected YYYY-MM-DD`)
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  return { from, to, isoDate }
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
