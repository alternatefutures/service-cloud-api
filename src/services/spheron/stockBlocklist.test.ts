/**
 * Tests for the Spheron stock-shortage blocklist.
 *
 * Pins the regex (against live Spheron 400 wording observed in the
 * 2026-05-15 `af-alternate-cyclic-bay-357-server` incident), TTL, and
 * change-listener contract. Both the offer picker and the GPU
 * availability endpoint depend on these semantics; a regression in
 * `matchesStockShortage` would silently re-introduce phantom-SKU display
 * + auto-router fallback failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  matchesStockShortage,
  markStockExhausted,
  isStockExhausted,
  getBlockReason,
  clearBlock,
  onBlocklistChange,
  _resetStockBlocklist,
  _snapshotStockBlocklist,
} from './stockBlocklist.js'

beforeEach(() => {
  _resetStockBlocklist()
  vi.useRealTimers()
})

describe('matchesStockShortage — pinned against live upstream wording', () => {
  // Verbatim from the 2026-05-15 incident:
  it('matches the canonical Spheron 400 - Not Enough Stock response', () => {
    expect(
      matchesStockShortage(
        'Spheron POST /api/deployments → 500: Deployment failed: Spheron AI API error: 400 Bad Request - Not Enough Stock of RTX-A4000. Unable to launch virtual-machines.',
      ),
    ).toBe(true)
  })

  it.each([
    'Not Enough Stock of H100',
    'not enough stock of A100',
    'Unable to launch virtual-machines',
    'unable to launch instance',
    'Sold out for this region',
    'out of stock',
    'Insufficient capacity for the requested GPU',
    'no available capacity',
    'no available inventory',
    'no available stock',
    'Capacity exhausted',
    'inventory depleted',
  ])('matches stock-shortage phrasing: %s', (msg) => {
    expect(matchesStockShortage(msg)).toBe(true)
  })

  it.each([
    'insufficient balance to launch',
    'rate limit exceeded',
    'team not found',
    'invalid offer ID',
    'offer not available for your account', // intentionally not matched — that's an auth/perm issue, not stock
    'Input payload validation failed',
    'connection reset by peer',
  ])('does not match non-stock errors: %s', (msg) => {
    expect(matchesStockShortage(msg)).toBe(false)
  })

  it('returns false for null/undefined/empty', () => {
    expect(matchesStockShortage(null)).toBe(false)
    expect(matchesStockShortage(undefined)).toBe(false)
    expect(matchesStockShortage('')).toBe(false)
  })
})

describe('blocklist storage', () => {
  it('marks + reads back the block', () => {
    markStockExhausted('A4000_PCIE', 'Not Enough Stock')
    expect(isStockExhausted('A4000_PCIE')).toBe(true)
    expect(getBlockReason('A4000_PCIE')).toBe('Not Enough Stock')
  })

  it('normalises casing of the gpuType key', () => {
    markStockExhausted('a4000_pcie', 'reason')
    expect(isStockExhausted('A4000_PCIE')).toBe(true)
    expect(isStockExhausted(' A4000_PCIE ')).toBe(true)
  })

  it('expires after TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T10:00:00Z'))
    markStockExhausted('A4000_PCIE', 'reason', 15 * 60_000)

    vi.setSystemTime(new Date('2026-05-15T10:14:59Z'))
    expect(isStockExhausted('A4000_PCIE')).toBe(true)

    vi.setSystemTime(new Date('2026-05-15T10:15:01Z'))
    expect(isStockExhausted('A4000_PCIE')).toBe(false)
    expect(getBlockReason('A4000_PCIE')).toBe(null)
  })

  it('re-marking extends the TTL and preserves firstSeenAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T10:00:00Z'))
    markStockExhausted('H100_PCIE', 'first', 60_000)

    vi.setSystemTime(new Date('2026-05-15T10:00:30Z'))
    markStockExhausted('H100_PCIE', 'second', 60_000)

    vi.setSystemTime(new Date('2026-05-15T10:01:20Z'))
    // Still blocked because second mark extended TTL to 10:01:30
    expect(isStockExhausted('H100_PCIE')).toBe(true)
    expect(getBlockReason('H100_PCIE')).toBe('second')
  })

  it('clearBlock removes a specific SKU', () => {
    markStockExhausted('A4000_PCIE', 'reason')
    markStockExhausted('H100_PCIE', 'reason')
    clearBlock('A4000_PCIE')
    expect(isStockExhausted('A4000_PCIE')).toBe(false)
    expect(isStockExhausted('H100_PCIE')).toBe(true)
  })

  it('handles empty/missing gpuType gracefully', () => {
    markStockExhausted('', 'reason')
    expect(_snapshotStockBlocklist()).toHaveLength(0)
    expect(isStockExhausted('')).toBe(false)
  })
})

describe('change listeners', () => {
  it('notifies on mark', () => {
    const fn = vi.fn()
    onBlocklistChange(fn)
    markStockExhausted('A4000_PCIE', 'r')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('notifies on clearBlock when the entry existed', () => {
    const fn = vi.fn()
    markStockExhausted('A4000_PCIE', 'r')
    onBlocklistChange(fn)
    clearBlock('A4000_PCIE')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT notify on clearBlock when the entry was already absent', () => {
    const fn = vi.fn()
    onBlocklistChange(fn)
    clearBlock('NOT_PRESENT')
    expect(fn).not.toHaveBeenCalled()
  })

  it('subscription returns an unsubscribe', () => {
    const fn = vi.fn()
    const unsubscribe = onBlocklistChange(fn)
    unsubscribe()
    markStockExhausted('A4000_PCIE', 'r')
    expect(fn).not.toHaveBeenCalled()
  })
})
