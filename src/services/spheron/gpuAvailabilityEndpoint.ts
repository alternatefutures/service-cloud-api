/**
 * Internal endpoint: GET /internal/spheron-gpu-availability
 *
 * Returns Spheron's live `gpu-offers` catalogue, filtered to the subset
 * we can actually deploy onto (`supportsCloudInit && available`), bucketed
 * by `(canonicalSlug, vramGi)` so the merged frontend dropdown can index
 * by the same key as `/internal/provider-registry?gpu=true`.
 *
 * Why this exists (vs. the existing `Query.spheronGpuOffers` GraphQL):
 *   - The GraphQL query returns the raw catalogue (one row per offer,
 *     grouped by gpuType). The frontend dropdown wants the AGGREGATE
 *     view: per `(slug, vram)` row, "how many offers + how many distinct
 *     providers + price band post-margin".
 *   - The merge step in the frontend `useStandardAvailableGpuGroups`
 *     hook needs a payload shape congruent with `/internal/provider-registry`
 *     so the union-by-key logic doesn't have to translate twice.
 *
 * Auth: `INTERNAL_AUTH_TOKEN` via `x-internal-auth` header — same contract
 * as `providerRegistryEndpoint.ts`.
 *
 * Response shape (stable; mirrored by `app/api/providers/spheron-gpu-availability/route.ts`):
 *
 *   {
 *     generatedAt: ISO,
 *     marginRate: number,         // 0.25 — DEFAULT_MONTHLY_MARGIN snapshot
 *     count: number,
 *     groups: [
 *       {
 *         value: string,                       // canonical Akash slug
 *         label: string,                       // "NVIDIA RTX 6000 Ada"
 *         vendor: 'nvidia' | 'amd',
 *         vramGi: number | null,               // VRAM per GPU
 *         offerCount: number,                  // # offers in the bucket
 *         providersWithAvailability: number,   // distinct providers
 *         clustersWithAvailability: number,    // distinct cluster strings
 *         minPriceUsdPerHour: number,          // post-margin
 *         maxPriceUsdPerHour: number,          // post-margin
 *         interconnectTypes: string[],         // ["PCIe", "SXM5"]
 *         spheronGpuTypes: string[],           // raw upstream tokens, for debug
 *       }
 *     ]
 *   }
 *
 * Failure modes:
 *   - SPHERON_API_KEY missing → 503 + `{ error: 'spheron-disabled' }`. Frontend
 *     hook treats this as "Spheron-side empty", merge proceeds Akash-only.
 *   - Upstream 5xx / network error → 502 + the raw upstream message
 *     (truncated); frontend hook retries with the same back-off as the
 *     Akash hook, falls through to Akash-only on persistent failure.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../../lib/logger.js'
import { DEFAULT_MONTHLY_MARGIN } from '../../config/pricing.js'
import { getSpheronClient, type SpheronGpuOffer, type SpheronGpuOfferGroup } from './client.js'
import { canonicalizeSpheronGpuType } from './canonicalize.js'

const log = createLogger('spheron-gpu-availability-endpoint')

const PAGE_LIMIT = 100
const MAX_PAGES = 5
const RESPONSE_CACHE_TTL_MS = 60_000

interface AggregatedGroup {
  value: string
  label: string
  vendor: 'nvidia' | 'amd'
  vramGi: number | null
  offerCount: number
  providersWithAvailability: number
  clustersWithAvailability: number
  minPriceUsdPerHour: number
  maxPriceUsdPerHour: number
  interconnectTypes: string[]
  spheronGpuTypes: string[]
}

interface CachedResponse {
  generatedAt: string
  marginRate: number
  count: number
  groups: AggregatedGroup[]
}

let _cache: { at: number; payload: CachedResponse } | null = null

function cacheIsFresh(): CachedResponse | null {
  if (!_cache) return null
  if (Date.now() - _cache.at > RESPONSE_CACHE_TTL_MS) return null
  return _cache.payload
}

/**
 * Best-effort vendor inference from the canonical slug. Mirrors
 * `vendorForModel` in the Akash route for consistency.
 */
function vendorForSlug(slug: string): 'nvidia' | 'amd' {
  if (/^(rx|mi)/i.test(slug)) return 'amd'
  return 'nvidia'
}

/**
 * Turn a canonical Akash slug into a friendly display label. Falls back
 * to upper-case + family-prefix if no match. The frontend has its own
 * `GPU_MODEL_LABELS` table — this is the offline default for cards the
 * frontend hasn't seen yet.
 */
function labelForSlug(slug: string): string {
  const map: Record<string, string> = {
    h200nvl: 'NVIDIA H200 NVL',
    h200: 'NVIDIA H200',
    h100: 'NVIDIA H100',
    a100: 'NVIDIA A100',
    a800: 'NVIDIA A800',
    a40: 'NVIDIA A40',
    a16: 'NVIDIA A16',
    a10: 'NVIDIA A10',
    v100: 'NVIDIA V100',
    t4: 'NVIDIA T4',
    l4: 'NVIDIA L4',
    l40: 'NVIDIA L40',
    l40s: 'NVIDIA L40S',
    b200: 'NVIDIA B200',
    b300: 'NVIDIA B300',
    gh200: 'NVIDIA GH200',
    rtxa6000: 'NVIDIA RTX A6000',
    rtxa5000: 'NVIDIA RTX A5000',
    rtxa4000: 'NVIDIA RTX A4000',
    rtxa2000: 'NVIDIA RTX A2000',
    pro6000se: 'NVIDIA RTX PRO 6000',
    pro6000we: 'NVIDIA RTX PRO 6000 WE',
    rtx6000ada: 'NVIDIA RTX 6000 Ada',
    rtx5090: 'NVIDIA RTX 5090',
    rtx5080: 'NVIDIA RTX 5080',
    rtx4090: 'NVIDIA RTX 4090',
    rtx4080: 'NVIDIA RTX 4080',
    rtx3090: 'NVIDIA RTX 3090',
    mi100: 'AMD MI100',
    mi60: 'AMD MI60',
  }
  if (map[slug]) return map[slug]
  return `${vendorForSlug(slug).toUpperCase()} ${slug.toUpperCase()}`
}

function applyMargin(usdPerHour: number): number {
  if (!Number.isFinite(usdPerHour) || usdPerHour <= 0) return 0
  return usdPerHour * (1 + DEFAULT_MONTHLY_MARGIN)
}

/**
 * Aggregate the live catalog into `(slug, vramGi)` rows.
 *
 * Bucket key uses `vramGi` so a 40 GB A100 (rare on Spheron, common on
 * Akash) ends up on a different row from an 80 GB A100. This mirrors the
 * locked design in `handoffs/2026-05-10_1330_spheron-gpu-dropdown-design-locked.md`
 * (split rows on VRAM disagreement).
 */
function aggregate(groups: SpheronGpuOfferGroup[]): AggregatedGroup[] {
  type AggKey = string
  const byKey = new Map<AggKey, {
    slug: string
    vramGi: number | null
    offers: SpheronGpuOffer[]
    providers: Set<string>
    clusters: Set<string>
    interconnectTypes: Set<string>
    spheronGpuTypes: Set<string>
  }>()

  for (const group of groups) {
    const groupSlug = canonicalizeSpheronGpuType(group.gpuType ?? '')
    if (!groupSlug) continue
    for (const offer of group.offers) {
      if (!offer.available) continue
      if (!offer.supportsCloudInit) continue
      // VRAM is per-GPU in offer.gpu_memory (GB ≈ GiB at the dropdown's
      // resolution; we don't try to convert here).
      const vramGi = Number.isFinite(offer.gpu_memory) && offer.gpu_memory > 0
        ? offer.gpu_memory
        : null
      // Use the offer-derived slug if it disagrees with the group slug
      // (rare — covers cases where a group bundles multiple SKUs that
      // diverge after canonicalisation). Falls back to group slug.
      const offerSlug = canonicalizeSpheronGpuType(offer.name ?? '') || groupSlug
      const slug = offerSlug || groupSlug
      const key: AggKey = `${slug}::${vramGi ?? 'null'}`
      let entry = byKey.get(key)
      if (!entry) {
        entry = {
          slug,
          vramGi,
          offers: [],
          providers: new Set(),
          clusters: new Set(),
          interconnectTypes: new Set(),
          spheronGpuTypes: new Set(),
        }
        byKey.set(key, entry)
      }
      entry.offers.push(offer)
      if (offer.provider) entry.providers.add(offer.provider)
      for (const c of offer.clusters ?? []) {
        if (c) entry.clusters.add(c)
      }
      if (offer.interconnectType) entry.interconnectTypes.add(offer.interconnectType)
      if (group.gpuType) entry.spheronGpuTypes.add(group.gpuType)
    }
  }

  const out: AggregatedGroup[] = []
  for (const entry of byKey.values()) {
    if (entry.offers.length === 0) continue
    const prices = entry.offers.map(o => o.price).filter(p => Number.isFinite(p) && p > 0)
    const minRaw = prices.length > 0 ? Math.min(...prices) : 0
    const maxRaw = prices.length > 0 ? Math.max(...prices) : 0
    out.push({
      value: entry.slug,
      label: labelForSlug(entry.slug),
      vendor: vendorForSlug(entry.slug),
      vramGi: entry.vramGi,
      offerCount: entry.offers.length,
      providersWithAvailability: entry.providers.size,
      clustersWithAvailability: entry.clusters.size,
      minPriceUsdPerHour: applyMargin(minRaw),
      maxPriceUsdPerHour: applyMargin(maxRaw),
      interconnectTypes: Array.from(entry.interconnectTypes).sort(),
      spheronGpuTypes: Array.from(entry.spheronGpuTypes).sort(),
    })
  }

  out.sort((a, b) => {
    if (b.providersWithAvailability !== a.providersWithAvailability) {
      return b.providersWithAvailability - a.providersWithAvailability
    }
    return a.label.localeCompare(b.label)
  })

  return out
}

async function buildResponse(): Promise<CachedResponse> {
  const client = getSpheronClient()
  if (!client) {
    throw Object.assign(new Error('spheron-disabled'), { code: 'spheron-disabled' })
  }

  const groups: SpheronGpuOfferGroup[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await client.listGpuOffers({
      instanceType: 'DEDICATED',
      sortBy: 'lowestPrice',
      sortOrder: 'asc',
      page,
      limit: PAGE_LIMIT,
    })
    groups.push(...response.data)
    if (page >= response.totalPages) break
  }

  const aggregated = aggregate(groups)
  return {
    generatedAt: new Date().toISOString(),
    marginRate: DEFAULT_MONTHLY_MARGIN,
    count: aggregated.length,
    groups: aggregated,
  }
}

export async function handleSpheronGpuAvailabilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const cached = cacheIsFresh()
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(cached))
      return
    }
    const payload = await buildResponse()
    _cache = { at: Date.now(), payload }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'spheron-disabled') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'spheron-disabled' }))
      return
    }
    log.error(
      { err: err instanceof Error ? err.message : err },
      'Spheron GPU availability endpoint failed',
    )
    const message = err instanceof Error ? err.message.slice(0, 400) : 'unknown'
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'spheron-upstream-failed', message }))
  }
}

/** Test-only — bust the in-memory cache between runs. */
export function _resetSpheronGpuAvailabilityCache(): void {
  _cache = null
}
