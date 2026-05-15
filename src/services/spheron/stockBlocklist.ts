/**
 * Spheron stock-shortage blocklist (in-memory, TTL'd).
 *
 * Why: Spheron's `listGpuOffers` returns `available: true` for offers whose
 * upstream provider has actually exhausted its inventory. POST then fails
 * with `400 - Not Enough Stock of <X>. Unable to launch virtual-machines.`
 * The dropdown and the picker both currently trust `available` — meaning
 * users see (and the picker selects) phantom SKUs that always fail at POST.
 *
 * This module is the single source of truth for "GPU SKU recently rejected
 * by Spheron for capacity reasons". Both surfaces query it before showing
 * or picking an offer:
 *
 *   - `offerPicker.pickSpheronOffer` skips blocklisted SKUs in its inner
 *     loop (the auto-router then falls back to Akash with `NO_CAPACITY`).
 *   - `gpuAvailabilityEndpoint.aggregate` skips blocklisted offers in the
 *     pre-aggregation pass so the dropdown hides them. A SKU is fully
 *     hidden only when EVERY offer for the `(slug, vramGi)` bucket is
 *     blocklisted; partial blocks still surface the row.
 *
 * Sources of truth:
 *   - `spheronSteps.handleDeployVm` (async retry POSTs) marks on
 *     `SpheronApiError` matching `matchesStockShortage`.
 *   - `orchestrator.deployServiceSpheron` (synchronous first POST) marks
 *     on the same.
 *
 * Lifetime: process-local. We use a short TTL (15 min default) because
 * Spheron stock turns over fast — we don't want to permanently hide a
 * SKU just because one VM at one provider sold out. Cleared on process
 * restart, which is the right behaviour: a restart is a fresh world.
 *
 * NOT a substitute for genuine availability tracking. If Spheron ever
 * surfaces a real-time stock API we'll replace this with a thin reader
 * on that endpoint; until then this is the pragmatic gap-closer.
 */

import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-stock-blocklist')

const DEFAULT_TTL_MS = 15 * 60_000 // 15 min — Spheron stock churn observed live

interface BlockEntry {
  /** Epoch ms when this block expires. */
  until: number
  /** Verbatim upstream message for diagnostics + structured logs. */
  reason: string
  /** When the block was first set (epoch ms). Useful for log correlation. */
  firstSeenAt: number
}

const _blocks = new Map<string, BlockEntry>()

/**
 * Listeners notified when a new block is added or an existing one is
 * cleared. Used by `gpuAvailabilityEndpoint` to bust its 60-s cache so
 * the dropdown reflects the latest blocklist state immediately instead
 * of waiting for the next TTL turnover.
 *
 * Decoupled to avoid an import cycle between the blocklist and the
 * availability endpoint.
 */
type BlocklistChangeListener = () => void
const _listeners = new Set<BlocklistChangeListener>()

export function onBlocklistChange(listener: BlocklistChangeListener): () => void {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

function notifyChange(): void {
  for (const listener of _listeners) {
    try {
      listener()
    } catch (err) {
      log.warn({ err }, 'stockBlocklist: change listener threw')
    }
  }
}

/**
 * Stock-shortage regex. The first three patterns are direct quotes from
 * Spheron's 400 response observed live on 2026-05-15
 * (`af-alternate-cyclic-bay-357-server` deploy):
 *
 *   "400 Bad Request - Not Enough Stock of RTX-A4000.
 *    Unable to launch virtual-machines."
 *
 * The remaining patterns are forward-compat for wording drift across
 * upstream provider integrations (Spheron aggregates 5+ providers, each
 * with their own error verbiage — this regex must be tolerant).
 *
 * Intentionally narrower than `NON_RETRYABLE_ERRORS`: that list also
 * includes balance/rate-limit conditions which AREN'T stock issues and
 * MUST NOT blocklist the SKU.
 */
const STOCK_SHORTAGE_REGEX = /not\s+enough\s+stock|unable\s+to\s+launch|sold\s+out|out\s+of\s+stock|insufficient\s+capacity|no\s+available\s+(?:capacity|inventory|stock)|capacity\s+(?:exhausted|depleted)|inventory\s+(?:exhausted|depleted)/i

/**
 * True iff the given error message matches a Spheron stock-shortage
 * upstream response. Case-insensitive, tolerant to wording drift across
 * Spheron's underlying providers.
 */
export function matchesStockShortage(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false
  return STOCK_SHORTAGE_REGEX.test(errorMessage)
}

/**
 * Normalise a Spheron `gpuType` token for blocklist storage. Mirrors the
 * upstream values verbatim (uppercased + underscore form) so callers can
 * pass raw upstream tokens without thinking about canonicalisation. We
 * intentionally do NOT canonicalise to Akash slugs here — the picker and
 * the aggregator both operate on Spheron's `group.gpuType`, so the
 * blocklist key must match that shape directly.
 */
function normalizeGpuType(gpuType: string): string {
  return gpuType.trim().toUpperCase()
}

/**
 * Mark a GPU SKU as out of stock for `ttlMs`. Idempotent — subsequent
 * calls during the active window extend the expiry (use the latest TTL)
 * while preserving the original `firstSeenAt` for log correlation.
 *
 * `reason` is the verbatim upstream message; it's surfaced in structured
 * logs so ops can grep for "blocklisted SKU + provider".
 */
export function markStockExhausted(
  gpuType: string,
  reason: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  if (!gpuType) return
  const key = normalizeGpuType(gpuType)
  const now = Date.now()
  const existing = _blocks.get(key)
  const entry: BlockEntry = {
    until: now + ttlMs,
    reason,
    firstSeenAt: existing?.firstSeenAt ?? now,
  }
  _blocks.set(key, entry)
  log.warn(
    { gpuType: key, ttlMs, reason: reason.slice(0, 200), firstSeenAt: entry.firstSeenAt },
    'Spheron SKU blocklisted (stock shortage)',
  )
  notifyChange()
}

/**
 * True iff the SKU is currently blocklisted. Expired entries are pruned
 * lazily here so callers never see a stale block.
 */
export function isStockExhausted(gpuType: string): boolean {
  if (!gpuType) return false
  const key = normalizeGpuType(gpuType)
  const entry = _blocks.get(key)
  if (!entry) return false
  if (Date.now() > entry.until) {
    _blocks.delete(key)
    return false
  }
  return true
}

/**
 * Return the active block reason, or null if the SKU isn't blocked.
 * Used by the orchestrator + step handlers to surface a useful message
 * when we short-circuit a deploy.
 */
export function getBlockReason(gpuType: string): string | null {
  if (!gpuType) return null
  const key = normalizeGpuType(gpuType)
  const entry = _blocks.get(key)
  if (!entry) return null
  if (Date.now() > entry.until) {
    _blocks.delete(key)
    return null
  }
  return entry.reason
}

/**
 * Force-clear a blocklist entry. Used by tests + ops paths (e.g. an
 * admin manually clearing the block after a Spheron provider issue is
 * resolved upstream).
 */
export function clearBlock(gpuType: string): void {
  if (!gpuType) return
  if (_blocks.delete(normalizeGpuType(gpuType))) {
    notifyChange()
  }
}

/**
 * Test-only — reset the entire blocklist between runs.
 */
export function _resetStockBlocklist(): void {
  _blocks.clear()
  _listeners.clear()
}

/**
 * Test-only — snapshot for assertion in unit tests.
 */
export function _snapshotStockBlocklist(): Array<{ gpuType: string; until: number; reason: string }> {
  const out: Array<{ gpuType: string; until: number; reason: string }> = []
  for (const [gpuType, entry] of _blocks.entries()) {
    out.push({ gpuType, until: entry.until, reason: entry.reason })
  }
  return out
}
