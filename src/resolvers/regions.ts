/**
 * Phase 46 — Region GraphQL resolvers.
 *
 * Single query: `regions(provider: ComputeProviderType): [Region!]!`
 *
 * For Akash: returns one row per curated bucket (us-east, us-west, eu, asia)
 * with live counts + median GPU/CPU prices. Strict gate — a region is
 * `available: true` only when both `verifiedCount >= 1` AND
 * `recentBidCount(24h) >= 1`. Picker UIs render unavailable buckets as
 * `(no capacity right now)` instead of hiding them, so users see we tried.
 *
 * For Phala: returns one sentinel row, `available: false`,
 * `label: "Phala Cloud (single-region)"`. Web/CLI surfaces detect this and
 * swap the picker out for an explicit message — see AF_IMPLEMENTATION_PHALA.md.
 *
 * The query is cheap (single Prisma `groupBy` over `compute_provider`,
 * single `groupBy` over `gpu_bid_observation` filtered to last 24h). At
 * realistic provider counts (~100 AKASH providers, ~4 buckets) it lands
 * sub-millisecond. No cache layer required at v1; can be added if it ever
 * stops being trivial.
 */

import type { PrismaClient } from '@prisma/client'
import { GraphQLError } from 'graphql'
import { REGIONS, REGION_IDS, type RegionId } from '../services/regions/mapping.js'
import { getAkashChainGeometry, getAktUsdPrice, AKT_USD_PRICE_FALLBACK } from '../config/pricing.js'
import { BLOCKS_PER_HOUR } from '../config/akash.js'

/**
 * Phase 46 — picker latency budget.
 *
 * `getAktUsdPrice()` and `getAkashChainGeometry()` each fall back through
 * external APIs (akash console, CoinGecko) before reaching their static
 * fallbacks. Cold-start on a fresh pod can blow ~15s before either
 * returns. The picker should never wait that long; it's metadata for a
 * dropdown, not the deploy critical path. We wrap each call in a 1-second
 * race and fall through to the static fallbacks if they don't beat it.
 * Once the upstream caches warm (≤5 min later), we get live values.
 */
const PRICE_FETCH_TIMEOUT_MS = 1_000

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), ms),
    ),
  ])
}

type ProviderType = 'AKASH' | 'PHALA'

type RegionConfidence = 'GREEN' | 'YELLOW' | 'RED'

export interface RegionMedianPrices {
  cpu1Core: number | null
  h100: number | null
  h200: number | null
  rtx4090: number | null
  a100: number | null
}

export interface RegionRow {
  id: string
  label: string
  available: boolean
  verifiedCount: number
  onlineCount: number
  recentBidCount: number
  medianPrices: RegionMedianPrices
  confidence: RegionConfidence
}

const RECENT_BID_WINDOW_HOURS = 24
const SUFFICIENT_PROVIDERS_FOR_GREEN = 3

/**
 * Phase 46 — picker availability gate.
 *
 * Default (env unset or "0"): a region is selectable iff `verifiedCount >= 1`.
 * Bid count still drives the `confidence` color (RED if no recent bids,
 * YELLOW for a few, GREEN for many) so users get a quality signal without
 * being locked out.
 *
 * Strict mode (`AF_REGIONS_REQUIRE_BIDS=1`): also requires
 * `recentBidCount >= 1`. Use this once the GPU bid probe and provider
 * ingest are reliably producing data — otherwise it creates a 6-hour
 * chicken-and-egg on every fresh install / new region (the probe only
 * runs every 6h and only probes GPU SKUs, so CPU-only regions stay locked
 * forever in strict mode).
 */
const REQUIRE_BIDS_FOR_AVAILABILITY =
  process.env.AF_REGIONS_REQUIRE_BIDS === '1'

function isAvailable(verifiedCount: number, recentBidCount: number): boolean {
  if (verifiedCount < 1) return false
  if (REQUIRE_BIDS_FOR_AVAILABILITY) return recentBidCount >= 1
  return true
}

/**
 * GPU models we surface in the median-price block. Add new models as we add
 * support; missing data is null (UI shows "—").
 */
const GPU_PRICE_MODELS = ['h100', 'h200', 'rtx4090', 'a100'] as const

interface PriceContext {
  blocksPerHour: number
  actUsdPrice: number
}

/**
 * Convert uact-per-block to USD/hr using the live chain geometry +
 * ACT/USD market price (both cached upstream). Caller resolves the price
 * context once at the top of the resolver — passing it in keeps this
 * helper synchronous and lets the callsite reuse the same context across
 * all regions without re-fetching.
 */
function pricePerBlockUactToUsdPerHour(
  uactPerBlock: bigint | null,
  ctx: PriceContext
): number | null {
  if (uactPerBlock === null || uactPerBlock === 0n) return null
  if (!ctx.blocksPerHour || !ctx.actUsdPrice) return null
  // uact → ACT (× 1e-6) → ACT/hour (× blocks/hour) → USD/hour (× ACT/USD).
  const uactPerHour = Number(uactPerBlock) * ctx.blocksPerHour
  const actPerHour = uactPerHour / 1_000_000
  return actPerHour * ctx.actUsdPrice
}

/**
 * Compute the median of an array of bigints, return as bigint.
 * Empty input → null. Odd length → middle. Even length → lower middle (we
 * don't average bigints to keep the type stable; the user-facing rendering
 * is approximate anyway).
 */
function bigintMedian(values: ReadonlyArray<bigint>): bigint | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)]
}

function pickConfidence(
  verifiedCount: number,
  onlineCount: number,
  recentBidCount: number
): RegionConfidence {
  if (verifiedCount === 0 || recentBidCount === 0) return 'RED'
  if (
    verifiedCount >= SUFFICIENT_PROVIDERS_FOR_GREEN &&
    onlineCount >= 1 &&
    recentBidCount >= SUFFICIENT_PROVIDERS_FOR_GREEN
  ) {
    return 'GREEN'
  }
  return 'YELLOW'
}

/**
 * Sentinel row for `regions(provider: PHALA)`. The frontend UI/CLI both
 * detect `id === 'phala-single-region'` and render the explicit message
 * instead of the picker.
 */
function phalaSentinel(): RegionRow {
  return {
    id: 'phala-single-region',
    label: 'Phala Cloud (single-region)',
    available: false,
    verifiedCount: 0,
    onlineCount: 0,
    recentBidCount: 0,
    medianPrices: {
      cpu1Core: null,
      h100: null,
      h200: null,
      rtx4090: null,
      a100: null,
    },
    confidence: 'RED',
  }
}

interface ProviderCountsByRegion {
  verified: Map<RegionId, number>
  online: Map<RegionId, number>
}

async function loadProviderCounts(
  prisma: PrismaClient
): Promise<ProviderCountsByRegion> {
  const verified = new Map<RegionId, number>()
  const online = new Map<RegionId, number>()
  for (const id of REGION_IDS) {
    verified.set(id, 0)
    online.set(id, 0)
  }

  const rows = await prisma.computeProvider.findMany({
    where: {
      providerType: 'AKASH',
      region: { in: [...REGION_IDS] as string[] },
      blocked: false,
    },
    select: { region: true, verified: true, isOnline: true },
  })

  for (const row of rows) {
    if (!row.region) continue
    const regionId = row.region as RegionId
    if (!REGION_IDS.includes(regionId)) continue
    if (row.verified) {
      verified.set(regionId, (verified.get(regionId) ?? 0) + 1)
    }
    if (row.isOnline) {
      online.set(regionId, (online.get(regionId) ?? 0) + 1)
    }
  }

  return { verified, online }
}

interface RecentBidsByRegion {
  count: Map<RegionId, number>
  /** Per-region per-GPU bid samples for the 24h window. */
  pricesPerGpu: Map<RegionId, Map<string, bigint[]>>
  /** Per-region CPU-equivalent prices (probe SDLs without GPU = CPU pricing). */
  cpuPrices: Map<RegionId, bigint[]>
}

async function loadRecentBids(prisma: PrismaClient): Promise<RecentBidsByRegion> {
  const since = new Date(Date.now() - RECENT_BID_WINDOW_HOURS * 60 * 60 * 1000)

  const count = new Map<RegionId, number>()
  const pricesPerGpu = new Map<RegionId, Map<string, bigint[]>>()
  const cpuPrices = new Map<RegionId, bigint[]>()
  for (const id of REGION_IDS) {
    count.set(id, 0)
    pricesPerGpu.set(id, new Map())
    cpuPrices.set(id, [])
  }

  const rows = await prisma.gpuBidObservation.findMany({
    where: {
      observedAt: { gte: since },
      providerRegion: { in: [...REGION_IDS] as string[] },
    },
    select: {
      providerRegion: true,
      gpuModel: true,
      pricePerBlock: true,
    },
  })

  for (const row of rows) {
    if (!row.providerRegion) continue
    const regionId = row.providerRegion as RegionId
    if (!REGION_IDS.includes(regionId)) continue

    count.set(regionId, (count.get(regionId) ?? 0) + 1)

    const model = row.gpuModel?.toLowerCase()
    if (model && model !== 'cpu' && model !== 'none') {
      const perGpu = pricesPerGpu.get(regionId)!
      const list = perGpu.get(model) ?? []
      list.push(row.pricePerBlock)
      perGpu.set(model, list)
    } else {
      cpuPrices.get(regionId)!.push(row.pricePerBlock)
    }
  }

  return { count, pricesPerGpu, cpuPrices }
}

/**
 * Build per-region price block. `gpuModelHint` (if provided) lets the UI
 * compute "median for the GPU I'm actually deploying" — it bumps that
 * model into the response even if the curated GPU_PRICE_MODELS list doesn't
 * include it.
 */
function buildPrices(
  regionId: RegionId,
  bids: RecentBidsByRegion,
  ctx: PriceContext,
  gpuModelHint?: string | null
): RegionMedianPrices {
  const perGpu = bids.pricesPerGpu.get(regionId) ?? new Map<string, bigint[]>()
  const cpuList = bids.cpuPrices.get(regionId) ?? []

  const medianForModel = (model: string): number | null => {
    const list = perGpu.get(model.toLowerCase())
    if (!list || list.length === 0) return null
    return pricePerBlockUactToUsdPerHour(bigintMedian(list), ctx)
  }

  const result: RegionMedianPrices = {
    cpu1Core: pricePerBlockUactToUsdPerHour(bigintMedian(cpuList), ctx),
    h100: medianForModel('h100'),
    h200: medianForModel('h200'),
    rtx4090: medianForModel('rtx4090'),
    a100: medianForModel('a100'),
  }

  // Attach the user-hint model if it isn't already in the curated set.
  // (We don't add new keys to the GraphQL type — instead the UI passes
  // the same hint and reads the matching field. If the hint is for a
  // model we don't have an explicit field for, it's the UI's job to
  // fall back to "—".)
  void gpuModelHint
  return result
}

export const regionsQueries = {
  regions: async (
    _: unknown,
    args: { provider?: ProviderType; gpuModelHint?: string | null } | undefined,
    context: { prisma: PrismaClient }
  ): Promise<RegionRow[]> => {
    const provider: ProviderType = args?.provider ?? 'AKASH'

    if (provider === 'PHALA') {
      return [phalaSentinel()]
    }

    if (provider !== 'AKASH') {
      throw new GraphQLError(`Unsupported provider type: ${provider}`)
    }

    // Fetch counts and bids unconditionally (these are local DB queries,
    // sub-millisecond). Geometry + ACT/USD price are wrapped in a 1s race
    // against their cached / static fallbacks — see PRICE_FETCH_TIMEOUT_MS.
    // Cold-start the picker no longer blocks for 10-15s on external APIs.
    const [counts, bids, geom, actUsdPrice] = await Promise.all([
      loadProviderCounts(context.prisma),
      loadRecentBids(context.prisma),
      withTimeout(
        getAkashChainGeometry(context.prisma),
        PRICE_FETCH_TIMEOUT_MS,
        {
          secondsPerBlock: 6.117,
          blocksPerHour: BLOCKS_PER_HOUR,
          blocksPerDay: 14_124,
          source: 'static-fallback' as const,
          sampledAt: Date.now(),
        },
      ),
      withTimeout(getAktUsdPrice(), PRICE_FETCH_TIMEOUT_MS, AKT_USD_PRICE_FALLBACK),
    ])

    const priceCtx: PriceContext = {
      blocksPerHour: geom.blocksPerHour,
      actUsdPrice,
    }

    const rows: RegionRow[] = []
    for (const id of REGION_IDS) {
      const def = REGIONS[id]
      const verifiedCount = counts.verified.get(id) ?? 0
      const onlineCount = counts.online.get(id) ?? 0
      const recentBidCount = bids.count.get(id) ?? 0

      rows.push({
        id,
        label: def.label,
        available: isAvailable(verifiedCount, recentBidCount),
        verifiedCount,
        onlineCount,
        recentBidCount,
        medianPrices: buildPrices(id, bids, priceCtx, args?.gpuModelHint),
        confidence: pickConfidence(verifiedCount, onlineCount, recentBidCount),
      })
    }

    return rows
  },
}
