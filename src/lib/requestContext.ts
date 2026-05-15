import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Per-request storage. Populated by the top-level request handler in
 * `src/index.ts` via `requestContext.run(...)` and inherited by every
 * async callback under that stack via Node's AsyncLocalStorage.
 *
 * `traceId` is the audit / observability trace id. It is the
 * value external clients and upstream services can send via
 * `X-AF-Trace-Id` to correlate logs across service-auth ↔ service-cloud-api
 * ↔ web-app. The `audit()` helper reads it from here when present.
 *
 * `requestId` is kept separate (even though we currently seed traceId
 * from the same header when no explicit trace header is supplied) so
 * log correlation (Pino mixin) stays decoupled from trace correlation.
 * If in future we add a sampling decision, `requestId` remains the
 * always-on log key while `traceId` may be absent for unsampled requests.
 */
interface RequestStore {
  requestId: string
  traceId: string
}

export const requestContext = new AsyncLocalStorage<RequestStore>()

export function getRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id']
  if (typeof incoming === 'string' && incoming.length > 0) return incoming
  return randomUUID()
}

/**
 * Resolve the traceId for this request:
 *   1. Caller-supplied `X-AF-Trace-Id` header (lowercased by Node).
 *   2. Caller-supplied `X-Request-Id` header (legacy fallback, so
 *      existing log-ids stay aligned with traces until D3 ships).
 *   3. Fresh uuid.
 *
 * The resolved id is echoed on the response as `x-af-trace-id` so the
 * caller can correlate their own logs.
 */
export function getTraceId(req: IncomingMessage): string {
  const explicit = req.headers['x-af-trace-id']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const legacy = req.headers['x-request-id']
  if (typeof legacy === 'string' && legacy.length > 0) return legacy
  return randomUUID()
}

/** Helper for modules that want the trace id without importing AsyncLocalStorage. */
export function currentTraceId(): string | undefined {
  return requestContext.getStore()?.traceId
}

