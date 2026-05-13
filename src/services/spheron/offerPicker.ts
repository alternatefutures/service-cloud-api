/**
 * Spheron offer picker.
 *
 * Selects a concrete `SpheronGpuOffer` from the live `client.listGpuOffers`
 * catalog, given a service's GPU + region constraints. Used by both
 * `deployToSpheron` and `deployFromTemplateToSpheron` resolvers.
 *
 * Locked decisions (Spheron Phase A / Phase C, 2026-05-06):
 *   - DEDICATED only in v1 (SPOT reserved for the SPOT phase).
 *   - `supportsCloudInit: true` is non-negotiable — our entire bring-up
 *     flow assumes Spheron will run our cloudInit payload.
 *   - Region buckets follow the Phase 46 curation:
 *     us-east | us-west | eu | asia. Per Phase C decision, when the caller
 *     sets a region the picker is STRICT — no offers in that bucket = throw
 *     `NoSpheronCapacityError`. The web-app's auto-router then falls back
 *     to Akash. (We never silently relax the region constraint; that would
 *     surprise users who picked "EU only" for compliance reasons.)
 *   - GPU model match is case-insensitive substring against the offer's
 *     `gpuType` AND the group's `gpuModel` / `displayName`. If
 *     `acceptableGpuModels` is empty/unset we accept any GPU (price-first).
 *   - Cheapest-first sort. If the upstream provider returns ties, the
 *     order is determined by upstream — we don't tiebreak further (the
 *     Phase C "Spheron-first absolute" auto-route decision means we don't
 *     need a sub-tiebreaker to avoid double-prefer behavior).
 *
 * No DB / no HTTP itself — given a `SpheronClient` instance, returns the
 * pick or throws. Pure orchestration logic for testability.
 */

import type {
  SpheronClient,
  SpheronGpuOffer,
  SpheronGpuOfferGroup,
  SpheronInstanceType,
} from './client.js'
import {
  canonicalizeAkashSlug,
  canonicalizeSpheronGpuType,
} from './canonicalize.js'

// ─── Region bucket map (Phase 46 buckets → cluster keyword regex) ────

/**
 * Phase 46 curated region buckets mapped to keyword regexes that match
 * Spheron upstream cluster strings.
 *
 * Cluster strings observed live (Phase H discovery 2026-04-21 + Phase 51
 * re-probe 2026-05-13):
 *   - data-crunch:    "Finland 3", "Iceland 1"
 *   - sesterce:       "amsterdam-netherlands-2", "kansascity-usa-1",
 *                     "desmoines-usa-1", "culpeper-usa-1", "warsaw-poland-1",
 *                     "montreal-canada-2"
 *   - voltage-park:   "us-east-virginia-1"
 *   - massed-compute: "Texas-1", "California-1", "us-central-2", "us-central-3"
 *   - spheron-es:     "EU North 1", "EU West 1", "US Central 1"
 *   - spheron-ai:     "CANADA-1"
 *
 * Update this map when a new cluster string is observed. False negatives
 * (cluster doesn't match any bucket) → that cluster is treated as "global"
 * and only included when no region filter is set. False positives (cluster
 * matches the wrong bucket) → user gets the wrong region; cheaper to fix
 * by adding a more specific regex than to silently relax the filter.
 *
 * Canada → us-east bucket: most live Canadian clusters today are eastern
 * (Montreal, Toronto, Quebec). When Spheron surfaces a Vancouver/Calgary
 * cluster we'll add it to us-west explicitly; for now the generic
 * `\bcanada\b` and bare `\bca\b` (cluster-name token) default to us-east
 * to avoid silently dropping them on every region-filtered query.
 */
// Common AWS-style compound region tokens we accept on either side of
// the more specific city/country names. Listed once and inlined so the
// per-bucket regex stays at a single place to update.
const COMPOUND_DIR = '(?:north|south|east|west|central|northeast|northwest|southeast|southwest)'

const REGION_BUCKETS: Record<string, RegExp> = {
  'us-east': new RegExp(
    `\\b(virginia|new[-_\\s]*york|nyc|new[-_\\s]*jersey|nj|atlanta|miami|maryland|north[-_\\s]*carolina|nc|us[-_\\s]?east|us[-_\\s]?central|texas|austin|dallas|chicago|illinois|kansas[-_\\s]?city|des[-_\\s]?moines|culpeper|canada|montreal|toronto|quebec|ottawa)\\b`,
    'i',
  ),
  'us-west': new RegExp(
    `\\b(california|cali|oregon|portland|washington[-_\\s]*state|wa\\b|san[-_\\s]*francisco|sf|los[-_\\s]*angeles|\\bla\\b|phoenix|arizona|las[-_\\s]*vegas|nevada|us[-_\\s]?west|vancouver|calgary|edmonton)\\b`,
    'i',
  ),
  'eu': new RegExp(
    `\\b(amsterdam|netherlands|germany|frankfurt|finland|iceland|stockholm|sweden|ireland|dublin|london|britain|uk\\b|paris|france|spain|madrid|milan|italy|warsaw|poland|switzerland|swiss|denmark|copenhagen|norway|oslo|estonia|portugal|lisbon|austria|vienna|belgium|brussels|europe|euro?|eu[-_\\s]?${COMPOUND_DIR})\\b`,
    'i',
  ),
  'asia': new RegExp(
    `\\b(singapore|sg\\b|japan|tokyo|osaka|seoul|korea|india|mumbai|bangalore|chennai|hong[-_\\s]*kong|hk\\b|taiwan|taipei|jakarta|indonesia|bangkok|thailand|malaysia|sydney|melbourne|australia|aus\\b|asia|apac|ap[-_\\s]?${COMPOUND_DIR})\\b`,
    'i',
  ),
}

const VALID_BUCKETS = new Set(Object.keys(REGION_BUCKETS))

/**
 * Returns true if `cluster` should be included for the given `bucket`.
 * `null` bucket ("Any region") accepts every cluster.
 */
export function clusterMatchesBucket(cluster: string, bucket: string | null | undefined): boolean {
  if (!bucket) return true
  const re = REGION_BUCKETS[bucket]
  if (!re) {
    // Caller passed an unknown bucket — fall through to "global", same as
    // no-bucket. This is intentional: an unknown bucket is a programming
    // error elsewhere; we don't want to fail-closed and starve deploys.
    return true
  }
  return re.test(cluster)
}

// ─── Errors ──────────────────────────────────────────────────────────

/**
 * Thrown when no offer in the live catalog matches the caller's
 * constraints. The web-app's auto-router catches this and falls back to
 * Akash (per Phase C tiebreaker decision: Spheron-first, Akash fallback).
 */
export class NoSpheronCapacityError extends Error {
  readonly reason: string
  readonly bucket: string | null
  readonly gpuConstraint: SpheronGpuConstraint

  constructor(reason: string, ctx: { bucket?: string | null; gpuConstraint: SpheronGpuConstraint }) {
    super(reason)
    this.name = 'NoSpheronCapacityError'
    this.reason = reason
    this.bucket = ctx.bucket ?? null
    this.gpuConstraint = ctx.gpuConstraint
  }
}

// ─── Inputs ──────────────────────────────────────────────────────────

export interface SpheronGpuConstraint {
  /** Exactly N GPUs required. Defaults to 1 when not provided. */
  gpuCount?: number
  /**
   * Acceptable GPU model substrings (e.g. ["A100", "H100_SXM5"]). Empty/
   * unset = any GPU is acceptable. Match is case-insensitive substring
   * against offer.gpuType / group.gpuType / group.gpuModel / group.displayName.
   */
  acceptableGpuModels?: string[]
}

export interface PickOfferOptions {
  client: SpheronClient
  /**
   * v1 = 'DEDICATED' only. Reserved for future SPOT/CLUSTER selection.
   */
  instanceType: SpheronInstanceType
  bucket?: string | null
  gpuConstraint: SpheronGpuConstraint
  /** Power-user override — pick this exact offer if found. */
  offerIdOverride?: string | null
  /** Power-user override — restrict to this upstream provider name. */
  providerOverride?: string | null
}

export interface PickedOffer {
  offer: SpheronGpuOffer
  group: SpheronGpuOfferGroup
  /**
   * The cluster string we'll pass on POST /api/deployments. Always one of
   * `offer.clusters[]`. When `bucket` is set we pick the first cluster
   * that matches the bucket; otherwise the first available cluster.
   */
  region: string
  /**
   * The OS string we'll pass on POST. Picks the first preinstalled-Docker
   * choice when available, else `offer.os_options[0]` (apt-install path).
   */
  operatingSystem: string
}

// ─── Helpers ─────────────────────────────────────────────────────────

function gpuMatchesAcceptable(
  offer: SpheronGpuOffer,
  group: SpheronGpuOfferGroup,
  acceptableModels: string[] | undefined,
): boolean {
  if (!acceptableModels || acceptableModels.length === 0) return true

  // Two-track match:
  //
  // 1. CANONICAL match (load-bearing for the merged dropdown). The frontend
  //    writes Akash-canonical slugs into `policy.acceptableGpuModels`
  //    (`'rtxa4000'`, `'pro6000se'`, etc.). Spheron's `gpuType` uses
  //    different tokens for the same SKUs (`'A4000_PCIE'`,
  //    `'RTXPRO6000_PCIE'`). Canonicalising both sides to the Akash slug
  //    closes the gap so a user who picks "RTX A4000" in the dropdown
  //    actually reaches Spheron's A4000 offers.
  //
  // 2. SUBSTRING fallback (forward-compat). If the offer's gpuType isn't in
  //    `SPHERON_TO_AKASH_EXPLICIT` yet (new SKU surfaced by Spheron before
  //    we add a map row), fall back to the original substring behaviour
  //    against an upper-cased haystack. `canonicalizeAkashSlug` produces
  //    the right needle ('rtxa4000' → 'A4000', 'h100' → 'H100').
  const canonicalHaystack = new Set(
    [
      canonicalizeSpheronGpuType(group.gpuType ?? ''),
      canonicalizeSpheronGpuType(group.gpuModel ?? ''),
      canonicalizeSpheronGpuType(group.displayName ?? ''),
      canonicalizeSpheronGpuType(offer.name ?? ''),
    ].filter(s => s.length > 0),
  )
  const upperHaystack = [
    offer.name ?? '',
    group.gpuType ?? '',
    group.gpuModel ?? '',
    group.displayName ?? '',
  ]
    .map(s => s.toUpperCase())
    .filter(s => s.length > 0)

  for (const wanted of acceptableModels) {
    const w = wanted.trim().toLowerCase()
    if (!w) continue
    if (canonicalHaystack.has(w)) return true
    const fragment = canonicalizeAkashSlug(w)
    if (upperHaystack.some(h => h.includes(fragment))) return true
  }
  return false
}

function pickRegion(offer: SpheronGpuOffer, bucket: string | null | undefined): string | null {
  if (offer.clusters.length === 0) return null
  if (!bucket) return offer.clusters[0]
  for (const c of offer.clusters) {
    if (clusterMatchesBucket(c, bucket)) return c
  }
  return null
}

function pickOperatingSystem(offer: SpheronGpuOffer): string | null {
  const opts = offer.os_options ?? []
  if (opts.length === 0) return null
  // Prefer Docker-preinstalled images so cloud-init skips the apt step.
  // The cloudInit builder works on either path; this is a perf hint only.
  const preinstalled = opts.find(o => /\bdocker\b/i.test(o))
  return preinstalled ?? opts[0]
}

// ─── Picker ──────────────────────────────────────────────────────────

/**
 * Live-catalog offer picker. Throws `NoSpheronCapacityError` when no offer
 * matches; the web-app's auto-router catches this and falls back to Akash.
 *
 * The picker fetches the entire DEDICATED catalog (sorted cheapest-first)
 * and walks groups in order. We page through up to `MAX_PAGES` to cap
 * worst-case latency on a busy catalog; in practice the cheapest matching
 * offer almost always lands on page 1.
 */
export async function pickSpheronOffer(opts: PickOfferOptions): Promise<PickedOffer> {
  const requiredGpuCount = Math.max(1, opts.gpuConstraint.gpuCount ?? 1)
  const bucket = opts.bucket ?? null
  if (bucket && !VALID_BUCKETS.has(bucket)) {
    throw new NoSpheronCapacityError(
      `Unknown region bucket "${bucket}". Expected one of: ${[...VALID_BUCKETS].join(', ')}.`,
      { bucket, gpuConstraint: opts.gpuConstraint },
    )
  }

  const MAX_PAGES = 5
  const PAGE_LIMIT = 50

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await opts.client.listGpuOffers({
      instanceType: opts.instanceType,
      sortBy: 'lowestPrice',
      sortOrder: 'asc',
      page,
      limit: PAGE_LIMIT,
    })

    for (const group of response.data) {
      for (const offer of group.offers) {
        if (!offer.available) continue
        if (!offer.supportsCloudInit) continue
        if (offer.gpuCount < requiredGpuCount) continue
        if (offer.instanceType !== opts.instanceType) continue
        if (opts.offerIdOverride && offer.offerId !== opts.offerIdOverride) continue
        if (opts.providerOverride && offer.provider !== opts.providerOverride) continue
        if (!gpuMatchesAcceptable(offer, group, opts.gpuConstraint.acceptableGpuModels)) continue

        const region = pickRegion(offer, bucket)
        if (!region) continue

        const operatingSystem = pickOperatingSystem(offer)
        if (!operatingSystem) continue

        return { offer, group, region, operatingSystem }
      }
    }

    if (page >= response.totalPages) break
  }

  throw new NoSpheronCapacityError(
    `No Spheron ${opts.instanceType} GPU offer matches the request` +
      (bucket ? ` in region "${bucket}"` : '') +
      (opts.gpuConstraint.acceptableGpuModels?.length
        ? ` (acceptable GPUs: ${opts.gpuConstraint.acceptableGpuModels.join(', ')})`
        : '') +
      '.',
    { bucket, gpuConstraint: opts.gpuConstraint },
  )
}
