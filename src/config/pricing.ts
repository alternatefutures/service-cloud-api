/**
 * Pricing Configuration for Alternate Clouds Platform (2026-02-14)
 *
 * Pricing model:
 *   - IPFS pinning: flat $0.01/GB (loss-leader, rounded to nearest GB)
 *   - All other storage/compute: pass-through provider cost + plan margin
 *     - Monthly plan: 25% markup
 *     - Yearly plan:  20% markup
 *   - Akash compute: provider bid cost + plan margin
 *   - Phala TEE: provider rate + plan margin
 *
 * All raw costs in USD. Margin is applied by the billing system at charge-time
 * using the org's active plan usageMarkup rate.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../lib/logger.js'
import { BLOCKS_PER_DAY, BLOCKS_PER_HOUR } from './akash.js'

const log = createLogger('pricing')

// Static fallback range for the live block-geometry feed. Akash's
// real block time has historically lived between 5.4s (16_000/day) and
// 7.2s (12_000/day); anything outside this band is almost certainly a
// bad data sample, not a real chain change. We clamp before caching.
const BLOCKS_PER_DAY_MIN = 12_000
const BLOCKS_PER_DAY_MAX = 16_000

// ============================================
// DEFAULT PLAN MARGINS (fallbacks — actual per-org
// margin comes from SubscriptionPlan.usageMarkup)
// ============================================

export const DEFAULT_MONTHLY_MARGIN = 0.25
export const DEFAULT_YEARLY_MARGIN = 0.20

// ============================================
// STORAGE — RAW PROVIDER COSTS
// ============================================

export const STORAGE_PRICING = {
  /** IPFS pinning — flat rate, NOT pass-through (loss-leader) */
  ipfs: {
    model: 'flat' as const,
    ratePerGb: 0.01, // $/GB/month — rounded to nearest GB
  },
  /** Filecoin storage deals — pass-through + margin */
  filecoin: {
    model: 'passthrough' as const,
    ratePerGb: 0.03, // raw provider cost $/GB/month (margin added at billing)
  },
  /** Arweave permanent storage — pass-through + margin, one-time */
  arweave: {
    model: 'passthrough' as const,
    ratePerGb: 5.0, // raw provider cost $/GB one-time (margin added at billing)
  },
  /** Storj decentralized storage — pass-through + margin */
  storj: {
    model: 'passthrough' as const,
    ratePerGb: 0.004, // raw provider cost $/GB/month
    egressPerGb: 0.007, // raw provider egress cost $/GB
  },
} as const

// ============================================
// COMPUTE — RAW PROVIDER COSTS
// ============================================

export const COMPUTE_PRICING = {
  /** Agent runtime — per hour */
  agentRuntime: 0.05,
  /** Function invocations — per million */
  functionInvocations: 0.2,
  /** GPU processing (ComfyUI/standard) — per hour */
  gpuProcessing: 0.5,
} as const

// ============================================
// SPHERON — INTENTIONALLY NO STATIC RATES
// ============================================
//
// Locked decision: Spheron pricing is **live-only**. Resolvers query
// `client.listGpuOffers()` at deploy time, snapshot the chosen offer's
// `price` onto `SpheronDeployment.originalHourlyRateCents` (pre-margin) and
// `hourlyRateCents` (post-margin), and never reference a config-file rate.
//
// Rationale: Spheron's catalogue spans dozens of providers × GPU types
// with frequent price changes (e.g. data-crunch flips H100 SXM5 hourly).
// A static config would either go stale and silently overcharge users or
// require a sync cron. Snapshotting at deploy time gives forensic
// reproducibility ("this row was billed at the price the user signed up
// for") without the staleness risk.
//
// DO NOT add `SPHERON_RATES` here. If a downstream caller needs a rate,
// they should read `SpheronDeployment.hourlyRateCents` from the row.

// ============================================
// PHALA TEE — RAW PROVIDER RATES ($/hr)
// ============================================

export const PHALA_RATES: Record<string, number> = {
  // CPU TEE instances (updated 2026-03-28 from phala instance-types)
  'tdx.small': 0.058,
  'tdx.medium': 0.116,
  'tdx.large': 0.232,
  'tdx.xlarge': 0.464,
  // GPU TEE instances
  'h100.small': 2.80,
  'h200.small': 3.50,
  'h200.8x.large': 23.04,
  'b200.small': 4.20,
}

// ============================================
// AKASH — CONVERSION HELPERS
// ============================================

/** Last-resort fallback — only used when ALL live sources fail. */
export const AKT_USD_PRICE_FALLBACK = parseFloat(process.env.AKT_USD_PRICE || '0.50')

/** @deprecated Use getAktUsdPrice() for live price. Kept for non-async call sites. */
export const AKT_USD_PRICE = AKT_USD_PRICE_FALLBACK

/**
 * Akash blocks per day, derived from measured ~6.117s block time.
 * Re-exported from `./akash.ts` so existing imports of this name keep working.
 *
 * @see ./akash.ts for the canonical block-geometry constants.
 */
export const AKASH_BLOCKS_PER_DAY = BLOCKS_PER_DAY

// ---- Live AKT price (Akash API → CoinGecko → env fallback) ----

let _aktCache: { price: number; ts: number } | null = null
const AKT_CACHE_TTL_MS = 5 * 60_000

async function fetchAkashMarketPrice(signal: AbortSignal): Promise<number | null> {
  const res = await fetch('https://console-api.akash.network/v1/market-data', { signal })
  if (!res.ok) throw new Error(`Akash API HTTP ${res.status}`)
  const data = (await res.json()) as { price?: number }
  return data.price && data.price > 0 ? data.price : null
}

async function fetchCoinGeckoPrice(signal: AbortSignal): Promise<number | null> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd',
    { signal },
  )
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  const data = (await res.json()) as { 'akash-network'?: { usd?: number } }
  const price = data['akash-network']?.usd
  return price && price > 0 ? price : null
}

/**
 * Fetch the current AKT/USD price with a 5-minute in-memory cache.
 * Sources tried in order: Akash Console API → CoinGecko → last cached → env fallback.
 */
export async function getAktUsdPrice(): Promise<number> {
  if (_aktCache && Date.now() - _aktCache.ts < AKT_CACHE_TTL_MS) {
    return _aktCache.price
  }

  const signal = AbortSignal.timeout(5_000)

  const sources: Array<[string, () => Promise<number | null>]> = [
    ['akash-api', () => fetchAkashMarketPrice(signal)],
    ['coingecko', () => fetchCoinGeckoPrice(signal)],
  ]

  for (const [name, fetcher] of sources) {
    try {
      const price = await fetcher()
      if (price) {
        _aktCache = { price, ts: Date.now() }
        log.info({ source: name, price }, 'AKT/USD price updated')
        return price
      }
    } catch (err) {
      log.warn({ source: name, err: (err as Error).message }, 'AKT price source failed')
    }
  }

  if (_aktCache?.price) {
    log.warn({ stalePrice: _aktCache.price, ageMs: Date.now() - _aktCache.ts }, 'All AKT price sources failed, using stale cache')
    return _aktCache.price
  }

  log.error({ fallback: AKT_USD_PRICE_FALLBACK }, 'All AKT price sources failed and no cache — using env fallback')
  return AKT_USD_PRICE_FALLBACK
}

// ---- Live Akash blocks-per-day feed ----
//
// Sources Akash console-api, derives `blocksPerDay` from the slope of
// the recent block-height vs. timestamp samples, clamps to a sane range,
// and caches for 1 hour.
//
// **CRITICAL**: this function is for *cost reporting and UI display
// only*. Do NOT use it in billing hot paths (`escrowHealthMonitor` refill
// math, `computeBillingScheduler` top-up amount, `escrowService`
// initial deposit). Billing math must produce identical numbers across
// consecutive cycles for the same lease — a UI value that drifts ±1%
// with chain conditions is fine, but a refill amount that does is how
// "deployment closed mid-hour, then re-funded for the wrong amount"
// bugs ship. Billing paths must keep using the static `BLOCKS_PER_HOUR`
// / `BLOCKS_PER_DAY` constants from `./akash.ts`.

export interface ChainGeometry {
  secondsPerBlock: number
  blocksPerHour: number
  blocksPerDay: number
  source: 'akash-console-api' | 'static-fallback' | 'cache'
  sampledAt: number
}

let _blocksCache: { value: ChainGeometry; ts: number } | null = null
const BLOCKS_CACHE_TTL_MS = 60 * 60_000

interface ConsoleApiBlock {
  height: number
  datetime: string
}

async function fetchAkashBlocksGeometry(signal: AbortSignal): Promise<ChainGeometry | null> {
  const res = await fetch('https://console-api.akash.network/v1/blocks', { signal })
  if (!res.ok) throw new Error(`Akash console-api HTTP ${res.status}`)
  const blocks = (await res.json()) as ConsoleApiBlock[]
  if (!Array.isArray(blocks) || blocks.length < 10) {
    throw new Error(`Akash console-api returned only ${blocks?.length ?? 0} blocks (need 10+)`)
  }
  // The endpoint returns most-recent-first; head/tail give us the
  // largest possible measurement window in one call.
  const head = blocks[0]
  const tail = blocks[blocks.length - 1]
  const headHeight = Number(head.height)
  const tailHeight = Number(tail.height)
  if (!Number.isFinite(headHeight) || !Number.isFinite(tailHeight) || headHeight <= tailHeight) {
    throw new Error('Akash console-api samples have unusable heights')
  }
  const headMs = Date.parse(head.datetime)
  const tailMs = Date.parse(tail.datetime)
  if (!Number.isFinite(headMs) || !Number.isFinite(tailMs) || headMs <= tailMs) {
    throw new Error('Akash console-api samples have unusable timestamps')
  }
  const secondsPerBlock = (headMs - tailMs) / (headHeight - tailHeight) / 1000
  if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) {
    throw new Error(`Computed secondsPerBlock=${secondsPerBlock} is invalid`)
  }
  const blocksPerDayRaw = Math.round(86_400 / secondsPerBlock)
  if (blocksPerDayRaw < BLOCKS_PER_DAY_MIN || blocksPerDayRaw > BLOCKS_PER_DAY_MAX) {
    throw new Error(`blocksPerDay=${blocksPerDayRaw} outside sane range — refusing sample`)
  }
  return {
    secondsPerBlock,
    blocksPerHour: Math.round(3_600 / secondsPerBlock),
    blocksPerDay: blocksPerDayRaw,
    source: 'akash-console-api',
    sampledAt: Date.now(),
  }
}

/**
 * Persist a successful geometry sample into `chain_stats`. Best-effort —
 * a DB outage must NEVER break the in-memory cache hot path. We log and
 * swallow.
 *
 * The row is keyed `id = "akash-mainnet"` (the schema default) so this
 * is a single-row upsert. Survives pod restarts so a fresh replica can
 * hydrate the in-memory cache from DB on first call instead of always
 * paying the console-api round-trip.
 */
async function persistChainStats(
  prisma: PrismaClient,
  geometry: ChainGeometry,
): Promise<void> {
  try {
    await prisma.chainStats.upsert({
      where: { id: 'akash-mainnet' },
      create: {
        id: 'akash-mainnet',
        secondsPerBlock: geometry.secondsPerBlock,
        blocksPerDay: geometry.blocksPerDay,
        blocksPerHour: geometry.blocksPerHour,
        sourceUrl: 'https://console-api.akash.network/v1/blocks',
        sampledAt: new Date(geometry.sampledAt),
      },
      update: {
        secondsPerBlock: geometry.secondsPerBlock,
        blocksPerDay: geometry.blocksPerDay,
        blocksPerHour: geometry.blocksPerHour,
        sourceUrl: 'https://console-api.akash.network/v1/blocks',
        sampledAt: new Date(geometry.sampledAt),
      },
    })
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'persistChainStats failed — chain_stats row not updated'
    )
  }
}

/**
 * Returns Akash chain block geometry (seconds/block, blocks/hour,
 * blocks/day). Cached for 1h in memory. Optional `prisma` arg enables
 * (a) persisting fresh samples to `chain_stats` for cold-start
 * hydration on a new pod, and (b) reading the last persisted sample as
 * a fallback when both the live API and the in-memory cache miss.
 *
 * Falls back to the static constants from `config/akash.ts` if every
 * live source AND the persisted row are unavailable.
 */
export async function getAkashChainGeometry(
  prisma?: PrismaClient,
): Promise<ChainGeometry> {
  if (_blocksCache && Date.now() - _blocksCache.ts < BLOCKS_CACHE_TTL_MS) {
    return { ..._blocksCache.value, source: 'cache' }
  }

  try {
    const signal = AbortSignal.timeout(5_000)
    const geometry = await fetchAkashBlocksGeometry(signal)
    if (geometry) {
      _blocksCache = { value: geometry, ts: Date.now() }
      log.info(
        { secondsPerBlock: geometry.secondsPerBlock, blocksPerDay: geometry.blocksPerDay },
        'Akash chain geometry refreshed'
      )
      if (prisma) await persistChainStats(prisma, geometry)
      return geometry
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'Akash console-api block sample failed — falling back to static constant'
    )
  }

  if (_blocksCache) {
    log.warn(
      { stale: _blocksCache.value, ageMs: Date.now() - _blocksCache.ts },
      'Live block-geometry sample failed — using stale cache'
    )
    return { ..._blocksCache.value, source: 'cache' }
  }

  // Cold-start path: pod just booted, no in-memory cache, live API
  // failed. Try the persisted row before giving up to the static
  // constant — that row was last written by a healthy pod and is
  // always closer to reality than the compile-time constant.
  if (prisma) {
    try {
      const row = await prisma.chainStats.findUnique({
        where: { id: 'akash-mainnet' },
      })
      if (row) {
        const hydrated: ChainGeometry = {
          secondsPerBlock: row.secondsPerBlock,
          blocksPerHour: row.blocksPerHour,
          blocksPerDay: row.blocksPerDay,
          source: 'cache',
          sampledAt: row.sampledAt.getTime(),
        }
        _blocksCache = { value: hydrated, ts: Date.now() }
        log.info(
          { sampledAt: row.sampledAt.toISOString(), blocksPerDay: row.blocksPerDay },
          'Hydrated geometry cache from chain_stats persisted row'
        )
        return hydrated
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'chain_stats hydration query failed — falling back to static constant'
      )
    }
  }

  return {
    secondsPerBlock: 86_400 / BLOCKS_PER_DAY,
    blocksPerHour: BLOCKS_PER_HOUR,
    blocksPerDay: BLOCKS_PER_DAY,
    source: 'static-fallback',
    sampledAt: Date.now(),
  }
}

/**
 * Convenience wrapper for callers that only need `blocksPerDay`.
 * Same caveats as `getAkashChainGeometry`: cost-reporting only — never
 * use in billing hot paths.
 */
export async function getAkashBlocksPerDay(prisma?: PrismaClient): Promise<number> {
  const geometry = await getAkashChainGeometry(prisma)
  return geometry.blocksPerDay
}

/** Test-only: drop the in-memory geometry cache. */
export function _resetAkashChainGeometryCacheForTests(): void {
  _blocksCache = null
}

// ============================================
// BANDWIDTH
// ============================================

export const BANDWIDTH_PRICING = {
  free: {
    included: 100, // GB
    overage: 0.1, // $/GB
  },
  pro: {
    included: 1024, // 1 TB
    overage: 0.08,
  },
  enterprise: {
    included: null as null,
    overage: null as null,
  },
} as const

// ============================================
// CONTAINER REGISTRY (Self-Hosted on Akash)
// ============================================

export const REGISTRY_PRICING = {
  storage: 0.06, // $/GB/month
  database: 0.1, // $/GB/month
  compute: 0.02, // $/hr
} as const

// ============================================
// BACKWARDS-COMPAT EXPORT
// ============================================

/** @deprecated Use STORAGE_PRICING, COMPUTE_PRICING, etc. directly */
export const PRICING = {
  storage: {
    ipfs: STORAGE_PRICING.ipfs.ratePerGb,
    filecoin: STORAGE_PRICING.filecoin.ratePerGb,
    arweave: STORAGE_PRICING.arweave.ratePerGb,
  },
  bandwidth: BANDWIDTH_PRICING,
  compute: COMPUTE_PRICING,
  registry: REGISTRY_PRICING,
} as const

// ============================================
// CALCULATION HELPERS
// ============================================

/**
 * Apply margin to a raw provider cost
 * @param rawCostUsd - Raw provider cost in USD
 * @param marginRate - Markup rate (e.g. 0.25 for 25%). Sourced from plan usageMarkup.
 * @returns Charged amount in USD
 */
export function applyMargin(rawCostUsd: number, marginRate: number): number {
  return rawCostUsd * (1 + marginRate)
}

/**
 * Calculate storage cost
 * For IPFS: flat rate (margin already baked in — loss-leader)
 * For others: raw cost only — caller must apply plan margin via applyMargin()
 *
 * @param storageType - The storage network type
 * @param sizeGB - Size in gigabytes
 * @param months - Number of months (default: 1, ignored for arweave)
 * @returns Raw cost in USD (before margin, except IPFS which is flat)
 */
export function calculateStorageCost(
  storageType: keyof typeof STORAGE_PRICING,
  sizeGB: number,
  months: number = 1
): number {
  const config = STORAGE_PRICING[storageType]

  // Arweave is one-time payment
  if (storageType === 'arweave') {
    return sizeGB * config.ratePerGb
  }

  // IPFS and others are monthly
  return sizeGB * config.ratePerGb * months
}

/**
 * Calculate storage cost with margin applied
 * Convenience wrapper that applies the plan's margin for pass-through providers.
 * IPFS is flat-rate (no additional margin).
 */
export function calculateStorageCostWithMargin(
  storageType: keyof typeof STORAGE_PRICING,
  sizeGB: number,
  marginRate: number,
  months: number = 1
): { rawCost: number; chargedCost: number; marginRate: number } {
  const rawCost = calculateStorageCost(storageType, sizeGB, months)
  const config = STORAGE_PRICING[storageType]

  // IPFS is flat-rate — no margin applied
  if (config.model === 'flat') {
    return { rawCost, chargedCost: rawCost, marginRate: 0 }
  }

  // Pass-through: apply plan margin
  return { rawCost, chargedCost: applyMargin(rawCost, marginRate), marginRate }
}

/**
 * Convert Akash pricePerBlock to USD per day.
 *
 * Since the BME upgrade (March 2026, Mainnet 17), all new Akash leases are
 * denominated in uact (micro-ACT), where ACT is a USD-pegged compute credit
 * (1 ACT = $1). The uact path is the only one used in production today:
 *   daily USD = (pricePerBlock × BLOCKS_PER_DAY) / 1,000,000
 *
 * The legacy uakt branch is retained only to handle any pre-BME escrow rows
 * that may still be queried during reconciliation. See `@deprecated` note
 * below.
 *
 * @param pricePerBlock - Price per block from the bid/lease
 * @param denom         - Token denomination ('uact' or 'uakt'). Defaults to 'uact' (post-BME).
 * @param aktUsdPrice   - Current AKT/USD rate. Only used when denom is 'uakt'.
 * @returns Daily cost in USD (raw, before margin)
 */
export function akashPricePerBlockToUsdPerDay(
  pricePerBlock: string | number,
  denom: string = 'uact',
  aktUsdPrice: number = AKT_USD_PRICE_FALLBACK,
): number {
  const price = typeof pricePerBlock === 'string' ? parseFloat(pricePerBlock) : pricePerBlock
  const dailyMicro = price * AKASH_BLOCKS_PER_DAY
  const dailyUnits = dailyMicro / 1_000_000

  if (denom === 'uakt') {
    /**
     * @deprecated Legacy pre-BME path. New leases (post-March 2026) all use
     * `uact`. If this branch fires in production it means a pre-BME escrow
     * row is still being processed — investigate which row and how it
     * survived the BME upgrade. Safe to remove this branch once the warn
     * log shows zero hits over a multi-week window.
     */
    log.warn(
      { pricePerBlock: price, aktUsdPrice },
      'Legacy uakt price conversion called — should not happen post-BME',
    )
    return dailyUnits * aktUsdPrice
  }

  // uact (ACT) is USD-pegged: 1 ACT = $1
  return dailyUnits
}

/**
 * Get Phala TEE hourly rate for a given CVM size
 * @param cvmSize - CVM size tier (e.g. 'tdx.large')
 * @returns Hourly rate in USD (raw, before margin)
 */
export function getPhalaHourlyRate(cvmSize: string): number {
  return PHALA_RATES[cvmSize] ?? PHALA_RATES['tdx.large'] // default to large
}

/**
 * Calculate bandwidth overage cost
 */
export function calculateBandwidthCost(
  tier: 'free' | 'pro' | 'enterprise',
  usageGB: number
): number {
  const tierConfig = BANDWIDTH_PRICING[tier]

  if (tier === 'enterprise' || !tierConfig.included || !tierConfig.overage) {
    return 0
  }

  const overage = Math.max(0, usageGB - tierConfig.included)
  return overage * tierConfig.overage
}

/**
 * Calculate compute cost
 */
export function calculateComputeCost(
  type: keyof typeof COMPUTE_PRICING,
  units: number
): number {
  return units * COMPUTE_PRICING[type]
}

/**
 * Calculate monthly registry hosting cost on Akash
 */
export function calculateRegistryCost(
  storageGB: number,
  databaseGB: number,
  computeHours: number = 730
): number {
  return (
    storageGB * REGISTRY_PRICING.storage +
    databaseGB * REGISTRY_PRICING.database +
    computeHours * REGISTRY_PRICING.compute
  )
}

/**
 * Get pricing information as a JSON object (for API responses / frontend)
 *
 * NOTE: All prices shown are the final user-facing price.
 * Internal cost structure (raw provider cost + margin) is never exposed.
 */
export function getPricingInfo() {
  return {
    storage: [
      {
        network: 'IPFS',
        type: 'Per GB/month',
        price: STORAGE_PRICING.ipfs.ratePerGb,
      },
      {
        network: 'Filecoin',
        type: 'Per GB/month',
        price: STORAGE_PRICING.filecoin.ratePerGb,
      },
      {
        network: 'Arweave',
        type: 'One-time per GB',
        price: STORAGE_PRICING.arweave.ratePerGb,
      },
      {
        network: 'Storj',
        type: 'Per GB/month',
        price: STORAGE_PRICING.storj.ratePerGb,
        egressPrice: STORAGE_PRICING.storj.egressPerGb,
      },
    ],
    bandwidth: [
      {
        tier: 'Free',
        included: BANDWIDTH_PRICING.free.included,
        overage: BANDWIDTH_PRICING.free.overage,
      },
      {
        tier: 'Pro',
        included: BANDWIDTH_PRICING.pro.included,
        overage: BANDWIDTH_PRICING.pro.overage,
      },
      { tier: 'Enterprise', included: 'Custom', overage: 'Custom' },
    ],
    compute: [
      { service: 'Agent Runtime', price: COMPUTE_PRICING.agentRuntime, unit: 'hour' },
      { service: 'Function Invocations', price: COMPUTE_PRICING.functionInvocations, unit: 'million' },
      { service: 'GPU Processing', price: COMPUTE_PRICING.gpuProcessing, unit: 'hour' },
    ],
    phalaTee: Object.entries(PHALA_RATES).map(([size, rate]) => ({
      size,
      price: rate,
      unit: 'hour',
    })),
    registry: [
      { resource: 'IPFS Storage', price: REGISTRY_PRICING.storage, unit: 'GB/month' },
      { resource: 'PostgreSQL Database', price: REGISTRY_PRICING.database, unit: 'GB/month' },
      { resource: 'Akash Compute', price: REGISTRY_PRICING.compute, unit: 'hour' },
    ],
  }
}
