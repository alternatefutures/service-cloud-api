/**
 * Region GraphQL resolver. Single query: `regions(provider: ComputeProviderType): [Region!]!`
 *
 * AKASH: one row per curated bucket (us-east, us-west, eu, asia) with live
 * verified/online counts + median GPU/CPU prices.
 * PHALA / SPHERON: sentinel single-region row; clients swap the picker for
 * an explicit single-region message.
 *
 * Picker is metadata for a dropdown, not on the deploy critical path: every
 * external price/geometry fetch is wrapped in a 1s race against its static
 * fallback so cold-start does not block the UI.
 */

import type { PrismaClient } from '@prisma/client'
import { GraphQLError } from 'graphql'
import { REGIONS, REGION_IDS, type RegionId } from '../services/regions/mapping.js'
import { getAkashChainGeometry, getAktUsdPrice, AKT_USD_PRICE_FALLBACK } from '../config/pricing.js'
import { BLOCKS_PER_HOUR } from '../config/akash.js'

const PRICE_FETCH_TIMEOUT_MS = 1_000

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), ms),
    ),
  ])
}

type ProviderType = 'AKASH' | 'PHALA' | 'SPHERON'

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
 * Picker availability gate.
 *
 * Default (`AF_REGIONS_REQUIRE_BIDS` unset/0): selectable iff verifiedCount ≥ 1.
 * Strict (`AF_REGIONS_REQUIRE_BIDS=1`): also requires recentBidCount ≥ 1.
 * Bid count always drives the `confidence` color regardless of mode.
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
 * Sentinel row for single-region providers (Phala, Spheron). Frontend
 * detects the id and renders an explicit single-region message instead of
 * the bucket picker.
 */
function singleRegionSentinel(id: string, label: string): RegionRow {
  return {
    id,
    label,
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

function buildPrices(
  regionId: RegionId,
  bids: RecentBidsByRegion,
  ctx: PriceContext,
): RegionMedianPrices {
  const perGpu = bids.pricesPerGpu.get(regionId) ?? new Map<string, bigint[]>()
  const cpuList = bids.cpuPrices.get(regionId) ?? []

  const medianForModel = (model: string): number | null => {
    const list = perGpu.get(model.toLowerCase())
    if (!list || list.length === 0) return null
    return pricePerBlockUactToUsdPerHour(bigintMedian(list), ctx)
  }

  return {
    cpu1Core: pricePerBlockUactToUsdPerHour(bigintMedian(cpuList), ctx),
    h100: medianForModel('h100'),
    h200: medianForModel('h200'),
    rtx4090: medianForModel('rtx4090'),
    a100: medianForModel('a100'),
  }
}

export const regionsQueries = {
  regions: async (
    _: unknown,
    args: { provider?: ProviderType; gpuModelHint?: string | null } | undefined,
    context: { prisma: PrismaClient }
  ): Promise<RegionRow[]> => {
    const provider: ProviderType = args?.provider ?? 'AKASH'

    if (provider === 'PHALA') {
      return [singleRegionSentinel('phala-single-region', 'Phala Cloud (single-region)')]
    }

    if (provider === 'SPHERON') {
      return [singleRegionSentinel('spheron-single-region', 'Spheron (offer-based regions)')]
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
        medianPrices: buildPrices(id, bids, priceCtx),
        confidence: pickConfidence(verifiedCount, onlineCount, recentBidCount),
      })
    }

    return rows
  },
}
