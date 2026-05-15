/**
 * Provider → curated region resolution.
 *
 * Pure function from a provider's published metadata to one of the four
 * curated buckets, or null when nothing maps. The caller (registry refresh)
 * persists the result on `ComputeProvider.region`.
 *
 * Resolution priority — first match wins:
 *   1. Akashlytics lat/lon → nearest centroid (haversine)
 *   2. Chain attribute `region` / `zone` matches an alias (case-insensitive substring)
 *   3. Chain attribute `country` (lowercased) in a region's country list,
 *      with US tiebreak via lat/lon when present
 *   4. Chain attribute `host` matches a region's host heuristic
 *   5. Manual override row (passed in by the caller; null = no override)
 *   6. None of the above → null
 *
 * Why this order:
 *   - Akashlytics lat/lon is observed (geoip-derived), more reliable than
 *     operator-published strings.
 *   - Operator-published `region` is high signal when present and matches
 *     a known alias — second-best.
 *   - Country alone is too coarse for US (us-east vs us-west indistinguishable
 *     without a hint), but unambiguous for everything else.
 *   - Host heuristic catches the "operator put location in their hostname
 *     but didn't tag it" case.
 *   - Manual override is *last* in the resolution flow but takes effect by
 *     the caller checking it before invoking this function — see
 *     `providerSelector.ts`. Encoded here for completeness.
 */

import { REGIONS, REGION_IDS, type RegionDefinition, type RegionId } from './mapping.js'

export interface ProviderMetadata {
  /** Akashlytics-sourced latitude (degrees). */
  lat?: number | null
  /** Akashlytics-sourced longitude (degrees). */
  lon?: number | null
  /** Chain attribute `region` (or `zone`) — operator-published, lowercased. */
  region?: string | null
  /** Chain attribute `country` — ISO 3166-1 alpha-2, lowercased. */
  country?: string | null
  /** Chain attribute `host` — provider FQDN, lowercased. */
  host?: string | null
}

export interface ResolveResult {
  region: RegionId | null
  /** Which branch matched. Useful for logging and admin "why is this provider in X" queries. */
  source:
    | 'akashlytics_latlon'
    | 'chain_region_alias'
    | 'chain_country'
    | 'chain_host'
    | 'manual_override'
    | 'unresolved'
  /**
   * The lowercase ISO country code if available, regardless of which branch
   * picked the region. Persisted alongside `region` for admin reporting.
   */
  country: string | null
}

/**
 * Haversine distance between two lat/lon points in kilometres. We only need
 * relative distances for nearest-centroid bucketing, so any monotonic
 * function would do — using km keeps it readable in tests.
 */
function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371 // mean Earth radius
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Return the curated region whose centroid is geographically closest to
 * `point`, or null if `point` is invalid (NaN / out of range).
 */
export function nearestCentroid(point: {
  lat: number
  lon: number
}): RegionId | null {
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    point.lat < -90 ||
    point.lat > 90 ||
    point.lon < -180 ||
    point.lon > 180
  ) {
    return null
  }

  let best: { id: RegionId; dist: number } | null = null
  for (const id of REGION_IDS) {
    const def = REGIONS[id]
    const dist = haversineKm(point, def.centroid)
    if (!best || dist < best.dist) {
      best = { id, dist }
    }
  }
  return best?.id ?? null
}

function matchesAlias(
  defs: ReadonlyArray<RegionDefinition>,
  needle: string,
  field: 'regionAliases' | 'hostHeuristics'
): RegionDefinition | null {
  const lower = needle.toLowerCase().trim()
  if (!lower) return null

  // Sort aliases by length descending so longer (more specific) matches win
  // against generic ones (e.g. "us-east-1" before "east").
  const candidates = defs.flatMap((def) =>
    def[field].map((alias) => ({ def, alias: alias.toLowerCase() }))
  )
  candidates.sort((a, b) => b.alias.length - a.alias.length)

  for (const { def, alias } of candidates) {
    if (lower.includes(alias)) return def
  }
  return null
}

/**
 * Resolve a provider's metadata to a curated region.
 *
 * @param meta — combined chain attributes + Akashlytics lat/lon. All fields
 * optional; this function tolerates partial / inconsistent data and falls
 * through to `unresolved` rather than throwing.
 *
 * @param manualOverride — value from `compute_provider_region_override.region`
 * for this provider, or undefined if no override row exists. Pass `null`
 * (the column value) explicitly to force "unresolved" — that's the admin-
 * intended way to suppress a noisy auto-resolved tag.
 */
export function resolveProviderRegion(
  meta: ProviderMetadata,
  manualOverride?: RegionId | null | undefined
): ResolveResult {
  const country = meta.country?.toLowerCase().trim() || null

  // 5. Manual override takes effect *before* auto-resolution. The admin
  // override row is the operator's intent and beats every signal — including
  // explicit "force unresolved" via null.
  if (manualOverride !== undefined) {
    return { region: manualOverride, source: 'manual_override', country }
  }

  const allDefs = REGION_IDS.map((id) => REGIONS[id])

  // 1. Akashlytics lat/lon
  if (
    meta.lat !== null &&
    meta.lat !== undefined &&
    meta.lon !== null &&
    meta.lon !== undefined
  ) {
    const region = nearestCentroid({ lat: meta.lat, lon: meta.lon })
    if (region) {
      return { region, source: 'akashlytics_latlon', country }
    }
  }

  // 2. Chain attribute region/zone alias
  if (meta.region) {
    const def = matchesAlias(allDefs, meta.region, 'regionAliases')
    if (def) {
      return { region: def.id, source: 'chain_region_alias', country }
    }
  }

  // 3. Chain country (with US lat/lon tiebreak when possible)
  if (country) {
    // First try unambiguous countries (countryDefaultFor lists exactly one
    // region per country). For US, both us-east and us-west list "us" in
    // `countries`; only us-east lists it in `countryDefaultFor`.
    const defaults = allDefs.filter((d) =>
      d.countryDefaultFor?.includes(country)
    )
    if (defaults.length === 1) {
      // Pure country match — but if we have lat/lon and the country is US,
      // prefer the geographic answer.
      if (
        country === 'us' &&
        meta.lon !== null &&
        meta.lon !== undefined &&
        Number.isFinite(meta.lon)
      ) {
        // Western half (lon < -100) → us-west; otherwise us-east.
        return {
          region: meta.lon < -100 ? 'us-west' : 'us-east',
          source: 'chain_country',
          country,
        }
      }
      return { region: defaults[0].id, source: 'chain_country', country }
    }

    // Country listed in `countries` but no default (e.g. "us" without
    // tiebreak signal) — fall back to the first matching region by stable
    // order. For us, that's us-east.
    const inCountries = allDefs.find((d) => d.countries.includes(country))
    if (inCountries) {
      return { region: inCountries.id, source: 'chain_country', country }
    }
  }

  // 4. Host heuristic
  if (meta.host) {
    const def = matchesAlias(allDefs, meta.host, 'hostHeuristics')
    if (def) {
      return { region: def.id, source: 'chain_host', country }
    }
  }

  // 6. Nothing matched.
  return { region: null, source: 'unresolved', country }
}
