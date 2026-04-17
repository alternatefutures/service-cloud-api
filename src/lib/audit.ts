/**
 * Audit Log Writer (Phase 44 / D1)
 *
 * Fire-and-forget persistence of business events into the `AuditEvent`
 * table. The identical table exists in service-auth (see
 * `service-auth/prisma/schema.prisma`). The D3 export cron unifies both
 * halves into a single JSONL stream for forensic review of the first 100
 * users' activity.
 *
 * Contract:
 *   • Never throws. The caller is never blocked by audit I/O. A failed
 *     write logs at error level and is dropped — audit is best-effort,
 *     not transactional with business state.
 *   • Never persists raw secrets. The `sanitize()` pass strips keys that
 *     look like credentials, caps string length, and bounds object depth.
 *   • traceId falls back to the request-scoped AsyncLocalStorage
 *     requestId when the caller does not pass one explicitly. Background
 *     jobs should mint their own via `crypto.randomUUID()`.
 *
 * See `admin/cloud/docs/AF_DEPIN_RELIABILITY_PLAN.md` for the full Phase
 * 44 spec and the forthcoming D2 / D3 additions.
 */

import { randomUUID } from 'node:crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { requestContext } from './requestContext.js'
import { createLogger } from './logger.js'

const log = createLogger('audit')

export type AuditStatus = 'ok' | 'warn' | 'error'

export type AuditCategory =
  | 'auth'
  | 'user'
  | 'billing'
  | 'deployment'
  | 'provider'
  | 'health'
  | 'ai-proxy'
  | 'cron'
  | 'system'

export interface AuditEventInput {
  /** Omit to inherit from requestContext, or pass a mint'd uuid for jobs. */
  traceId?: string
  /** Defaults to 'cloud-api'. Only override for framework/system events. */
  source?: string
  category: AuditCategory
  /** Verb-first, dotted. Examples: "deployment.requested", "lease.closed". */
  action: string
  /** Defaults to 'ok'. */
  status?: AuditStatus

  userId?: string | null
  orgId?: string | null
  projectId?: string | null
  serviceId?: string | null
  deploymentId?: string | null

  durationMs?: number
  payload?: Record<string, unknown>

  errorCode?: string
  errorMessage?: string
}

const DEFAULT_SOURCE = 'cloud-api'

/**
 * Write one audit event. Fire-and-forget; never throws.
 */
export function audit(prisma: PrismaClient, evt: AuditEventInput): void {
  try {
    const payload = sanitize(evt.payload ?? {}) as Prisma.InputJsonValue
    const data: Prisma.AuditEventUncheckedCreateInput = {
      traceId: evt.traceId ?? currentTraceId(),
      source: evt.source ?? DEFAULT_SOURCE,
      category: evt.category,
      action: evt.action,
      status: evt.status ?? 'ok',
      userId: evt.userId ?? null,
      orgId: evt.orgId ?? null,
      projectId: evt.projectId ?? null,
      serviceId: evt.serviceId ?? null,
      deploymentId: evt.deploymentId ?? null,
      durationMs: evt.durationMs,
      payload,
      errorCode: evt.errorCode ?? null,
      errorMessage: evt.errorMessage ? truncate(evt.errorMessage, 2_000) : null,
    }
    prisma.auditEvent
      .create({ data })
      .catch((err) => log.error({ err, action: evt.action }, 'audit write failed'))
  } catch (err) {
    log.error({ err, action: evt.action }, 'audit write rejected')
  }
}

/**
 * Wrap an async operation. Writes one audit event on success, one on
 * throw. Rethrows the original error so the caller's flow is preserved.
 * Prefer this over manual try/finally when the intent is "record what
 * just happened, including duration".
 */
export async function withAudit<T>(
  prisma: PrismaClient,
  base: Omit<
    AuditEventInput,
    'status' | 'durationMs' | 'errorCode' | 'errorMessage'
  >,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now()
  try {
    const result = await fn()
    audit(prisma, { ...base, status: 'ok', durationMs: Date.now() - started })
    return result
  } catch (err) {
    const anyErr = err as { code?: string; message?: string } | undefined
    audit(prisma, {
      ...base,
      status: 'error',
      durationMs: Date.now() - started,
      errorCode: anyErr?.code,
      errorMessage: anyErr?.message ?? String(err),
    })
    throw err
  }
}

/** Current trace id — the per-request requestId, or a fresh uuid. */
export function currentTraceId(): string {
  return requestContext.getStore()?.requestId ?? randomUUID()
}

// ────────────────────────────────────────────────────────────────────────────
// Privacy: strip obvious secrets, cap depth, cap length.
// ────────────────────────────────────────────────────────────────────────────

const SECRET_KEY_RE =
  /^(password|passwd|secret|token|authorization|cookie|set-cookie|private[_-]?key|api[_-]?key|jwt|session|card|cvc|cvv|pan|ssn)$/i

const MAX_STRING_LEN = 4_096
const MAX_DEPTH = 6
const MAX_ARRAY_LEN = 64

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated:depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncate(value, MAX_STRING_LEN)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_LEN)
    const out = new Array(limit)
    for (let i = 0; i < limit; i++) out[i] = sanitize(value[i], depth + 1)
    if (value.length > MAX_ARRAY_LEN) out.push(`[truncated:+${value.length - MAX_ARRAY_LEN}]`)
    return out
  }
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[redacted]'
        continue
      }
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
