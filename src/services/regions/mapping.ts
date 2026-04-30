/**
 * Phase 46 — Curated region catalog.
 *
 * Single source of truth for the region buckets we expose to users. Adding,
 * removing, or splitting a region is a code change here — that's intentional.
 * The product UX depends on a stable, small set of buckets, not on whatever
 * strings provider operators happen to publish.
 *
 * Resolution priority (see `resolve.ts`):
 *   1. Akashlytics lat/lon → nearest centroid
 *   2. Chain attribute `region`/`zone` matches an alias
 *   3. Chain attribute `country` in `countries` (with us-east/us-west tiebreak
 *      via lat/lon if any geographic hint is present, otherwise default)
 *   4. Chain attribute `host` matches a host-string heuristic
 *   5. Manual override row in `compute_provider_region_override`
 *   6. None → null (provider is invisible to region-filtered queries but
 *      still selectable for "Any (cheapest globally)")
 */

export type RegionId = 'us-east' | 'us-west' | 'eu' | 'asia'

export interface RegionDefinition {
  id: RegionId
  label: string
  /** Centroid for haversine-distance bucketing of Akashlytics lat/lon. */
  centroid: { lat: number; lon: number }
  /** ISO 3166-1 alpha-2 country codes (lowercase). */
  countries: ReadonlyArray<string>
  /** Lowercase substrings matched against chain attribute `region` / `zone`. */
  regionAliases: ReadonlyArray<string>
  /** Lowercase substrings matched against chain attribute `host` (FQDN). */
  hostHeuristics: ReadonlyArray<string>
  /**
   * For country-fallback ties (multiple regions claim the same country code),
   * `tieBreakLat` defines the boundary. Providers whose lat is < tieBreakLat
   * go to the southern region, ≥ goes north. For US, `lon` is used: < goes
   * west, ≥ goes east. Only set when there's an actual ambiguity to resolve.
   */
  countryTiebreak?: {
    field: 'lat' | 'lon'
    threshold: number
    losesTo: RegionId
  }
  /** Default region when only a country code is available and no tiebreak applies. */
  countryDefaultFor?: ReadonlyArray<string>
}

/**
 * The four buckets. Asia is intentionally one bucket for v1 — split into
 * `asia-east` / `asia-southeast` only when ≥2 verified providers exist in
 * each. See AF_REGION_SELECTION.md.
 */
export const REGIONS: Record<RegionId, RegionDefinition> = {
  'us-east': {
    id: 'us-east',
    label: 'US East',
    centroid: { lat: 38.5, lon: -77.5 }, // ~DC area
    countries: ['us'],
    regionAliases: [
      'us-east',
      'us-east-1',
      'us-east-2',
      'east-us',
      'na-east',
      'usa-east',
      'east',
    ],
    hostHeuristics: ['us-east', 'useast', 'east-us', 'usa-east'],
    // For "country: us" with no other hint, default to us-east.
    countryDefaultFor: ['us'],
  },
  'us-west': {
    id: 'us-west',
    label: 'US West',
    centroid: { lat: 37.0, lon: -120.0 },
    countries: ['us'],
    regionAliases: [
      'us-west',
      'us-west-1',
      'us-west-2',
      'west-us',
      'na-west',
      'usa-west',
      'west',
    ],
    hostHeuristics: ['us-west', 'uswest', 'west-us', 'usa-west'],
    // No `countryDefaultFor` — us-east wins ties on country alone.
  },
  eu: {
    id: 'eu',
    label: 'Europe',
    centroid: { lat: 50.0, lon: 10.0 },
    countries: [
      'de', 'nl', 'fr', 'gb', 'es', 'it', 'pl', 'fi', 'se', 'no',
      'dk', 'ie', 'at', 'cz', 'ch', 'be', 'pt', 'lu', 'ro', 'hu',
      'gr', 'sk', 'si', 'hr', 'lt', 'lv', 'ee', 'is',
    ],
    regionAliases: [
      'eu',
      'eu-west',
      'eu-west-1',
      'eu-central',
      'eu-central-1',
      'eu-north',
      'eu-south',
      'europe',
    ],
    hostHeuristics: ['eu-west', 'eu-central', 'eu-north', '.eu.', 'europe'],
    countryDefaultFor: [
      'de', 'nl', 'fr', 'gb', 'es', 'it', 'pl', 'fi', 'se', 'no',
      'dk', 'ie', 'at', 'cz', 'ch', 'be', 'pt', 'lu', 'ro', 'hu',
      'gr', 'sk', 'si', 'hr', 'lt', 'lv', 'ee', 'is',
    ],
  },
  asia: {
    id: 'asia',
    label: 'Asia Pacific',
    centroid: { lat: 25.0, lon: 120.0 },
    countries: [
      'jp', 'sg', 'kr', 'hk', 'tw', 'in', 'cn', 'id', 'my',
      'th', 'vn', 'ph', 'au', 'nz',
    ],
    regionAliases: [
      'asia',
      'asia-pacific',
      'apac',
      'ap-southeast',
      'ap-southeast-1',
      'ap-southeast-2',
      'ap-northeast',
      'ap-northeast-1',
      'ap-south',
      'ap-east',
    ],
    hostHeuristics: ['asia', 'apac', 'ap-southeast', 'ap-northeast'],
    countryDefaultFor: [
      'jp', 'sg', 'kr', 'hk', 'tw', 'in', 'cn', 'id', 'my',
      'th', 'vn', 'ph', 'au', 'nz',
    ],
  },
}

/**
 * Ordered list of region ids. Used for stable rendering and iteration.
 */
export const REGION_IDS: ReadonlyArray<RegionId> = [
  'us-east',
  'us-west',
  'eu',
  'asia',
]

/**
 * Cheap type guard for code paths that accept user-supplied region strings.
 */
export function isRegionId(value: unknown): value is RegionId {
  return typeof value === 'string' && REGION_IDS.includes(value as RegionId)
}

/**
 * Region by id, with a strict invariant — only callers that already know the
 * id is valid (or accept that a typo crashes loudly) should use this.
 */
export function getRegion(id: RegionId): RegionDefinition {
  return REGIONS[id]
}
