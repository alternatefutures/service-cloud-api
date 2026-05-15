/**
 * Region refresh.
 *
 * Resolves every AKASH `ComputeProvider`'s region and persists it back to
 * the row. Runs on its own cadence (default 30 min, configurable via env)
 * because the inputs change slowly:
 *
 *   - Akashlytics geographic data is scraped maybe once an hour upstream.
 *   - Operator-published chain attributes change rarely — usually on
 *     redeploy.
 *   - Manual overrides are an admin action.
 *
 * Failure modes are all fail-open: if Akashlytics is unreachable, we fall
 * back to chain attributes; if both are gone, we keep the existing row
 * value (so providers that *were* tagged stay tagged across a transient
 * outage). The function never throws — it logs and returns.
 *
 * The function is idempotent: running it twice in a row yields the same
 * region/country values for the same inputs. Diff-only writes minimize
 * row churn.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import {
  resolveProviderRegion,
  type ProviderMetadata,
  type ResolveResult,
} from './resolve.js'
import { isRegionId, type RegionId } from './mapping.js'

const log = createLogger('region-refresh')

const AKASHLYTICS_PROVIDERS_URL =
  process.env.AKASHLYTICS_PROVIDERS_URL ||
  'https://api.akashlytics.com/v1/providers'

const AKASHLYTICS_FETCH_TIMEOUT_MS = 15_000

/**
 * Shape of an Akashlytics `/v1/providers` row that we care about.
 * Fields not listed (e.g. `gpu`, `uptime30d`) are ignored.
 */
export interface AkashlyticsProviderRow {
  owner?: string
  hostUri?: string
  ipRegion?: string
  ipCountry?: string // ISO 3166-1 alpha-2 in some responses; full country name in others
  ipLat?: number | string | null
  ipLon?: number | string | null
  attributes?: Array<{ key: string; value: string }>
}

export interface AkashlyticsFetcher {
  (): Promise<AkashlyticsProviderRow[]>
}

/** Default fetcher — production path. Tests inject their own. */
export const defaultAkashlyticsFetcher: AkashlyticsFetcher = async () => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    AKASHLYTICS_FETCH_TIMEOUT_MS
  )
  try {
    const res = await fetch(AKASHLYTICS_PROVIDERS_URL, {
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Akashlytics responded ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as unknown
    if (!Array.isArray(data)) {
      throw new Error('Akashlytics response is not an array')
    }
    return data as AkashlyticsProviderRow[]
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull a value out of `attributes: [{key, value}]`, lowercased.
 */
function getAttr(
  attrs: Array<{ key: string; value: string }> | undefined,
  ...keys: string[]
): string | null {
  if (!attrs || !Array.isArray(attrs)) return null
  for (const key of keys) {
    const found = attrs.find(
      (a) => a?.key?.toLowerCase().trim() === key.toLowerCase()
    )
    if (found?.value) return String(found.value).toLowerCase().trim()
  }
  return null
}

/**
 * Coerce a possibly-string lat/lon (some APIs send strings) into number,
 * returning null for anything non-finite.
 */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Convert a country-like string to ISO 3166-1 alpha-2 lowercase, when
 * possible. Akashlytics is inconsistent — some rows say "us", some say
 * "United States". We lowercase + take the first 2 chars when the input
 * is exactly 2 chars; otherwise we map a small set of common full names
 * and fall back to null. Unknown countries are stored as null rather
 * than as the full name to keep `country` consistent.
 */
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  'united states': 'us',
  'united states of america': 'us',
  usa: 'us',
  germany: 'de',
  france: 'fr',
  netherlands: 'nl',
  'united kingdom': 'gb',
  'great britain': 'gb',
  britain: 'gb',
  spain: 'es',
  italy: 'it',
  poland: 'pl',
  finland: 'fi',
  sweden: 'se',
  norway: 'no',
  denmark: 'dk',
  ireland: 'ie',
  austria: 'at',
  czechia: 'cz',
  'czech republic': 'cz',
  switzerland: 'ch',
  belgium: 'be',
  portugal: 'pt',
  japan: 'jp',
  singapore: 'sg',
  'south korea': 'kr',
  korea: 'kr',
  'hong kong': 'hk',
  taiwan: 'tw',
  india: 'in',
  china: 'cn',
  indonesia: 'id',
  malaysia: 'my',
  thailand: 'th',
  vietnam: 'vn',
  philippines: 'ph',
  australia: 'au',
  'new zealand': 'nz',
}

export function normalizeCountry(input: unknown): string | null {
  if (!input) return null
  const s = String(input).toLowerCase().trim()
  if (s.length === 2 && /^[a-z]{2}$/.test(s)) return s
  return COUNTRY_NAME_TO_ISO[s] ?? null
}

/**
 * Build a `ProviderMetadata` for one Akashlytics row.
 */
export function metadataFromAkashlytics(
  row: AkashlyticsProviderRow
): ProviderMetadata {
  const region =
    row.ipRegion?.toLowerCase().trim() ||
    getAttr(row.attributes, 'region', 'zone')

  return {
    lat: toNum(row.ipLat),
    lon: toNum(row.ipLon),
    region: region || null,
    country: normalizeCountry(row.ipCountry ?? getAttr(row.attributes, 'country')),
    host: row.hostUri?.toLowerCase().trim() || getAttr(row.attributes, 'host'),
  }
}

/**
 * Build a `ProviderMetadata` from chain-only attributes (no Akashlytics).
 * Used for providers Akashlytics doesn't know about — they still get a
 * shot at chain-attribute-based resolution.
 */
export function metadataFromChainAttributes(
  attributes: unknown
): ProviderMetadata {
  if (!attributes || typeof attributes !== 'object') {
    return { lat: null, lon: null, region: null, country: null, host: null }
  }

  // Chain attributes can be either an array of {key, value} or a flat
  // {key: value} object. Handle both shapes.
  let pairs: Array<{ key: string; value: string }> = []
  if (Array.isArray(attributes)) {
    pairs = (attributes as Array<{ key?: unknown; value?: unknown }>)
      .filter((a) => typeof a?.key === 'string')
      .map((a) => ({ key: String(a.key), value: String(a.value ?? '') }))
  } else {
    pairs = Object.entries(attributes as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => ({ key: k, value: String(v) }))
  }

  return {
    lat: toNum(getAttr(pairs, 'lat', 'latitude', 'ip-lat')),
    lon: toNum(getAttr(pairs, 'lon', 'longitude', 'ip-lon')),
    region: getAttr(pairs, 'region', 'zone'),
    country: normalizeCountry(getAttr(pairs, 'country')),
    host: getAttr(pairs, 'host'),
  }
}

export interface RefreshSummary {
  scanned: number
  resolved: number
  unresolved: number
  changedRegion: number
  changedCountry: number
  bySource: Record<ResolveResult['source'], number>
  durationMs: number
}

/**
 * Refresh `ComputeProvider.region` and `ComputeProvider.country` for every
 * AKASH provider. Idempotent. Diff-only writes. Fail-open.
 */
export async function refreshProviderRegions(
  prisma: PrismaClient,
  fetcher: AkashlyticsFetcher = defaultAkashlyticsFetcher
): Promise<RefreshSummary> {
  const start = Date.now()
  const summary: RefreshSummary = {
    scanned: 0,
    resolved: 0,
    unresolved: 0,
    changedRegion: 0,
    changedCountry: 0,
    bySource: {
      akashlytics_latlon: 0,
      chain_region_alias: 0,
      chain_country: 0,
      chain_host: 0,
      manual_override: 0,
      unresolved: 0,
    },
    durationMs: 0,
  }

  // Akashlytics scrape — best effort.
  let akashlyticsByAddress = new Map<string, AkashlyticsProviderRow>()
  try {
    const rows = await fetcher()
    for (const row of rows) {
      if (row?.owner) {
        akashlyticsByAddress.set(String(row.owner).toLowerCase(), row)
      }
    }
    log.info(
      { count: akashlyticsByAddress.size },
      'Akashlytics provider scrape OK'
    )
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'Akashlytics scrape failed — falling back to chain attributes only'
    )
    akashlyticsByAddress = new Map()
  }

  // Manual overrides.
  let overridesByAddress = new Map<string, RegionId | null>()
  try {
    const overrides = await prisma.computeProviderRegionOverride.findMany({
      select: { providerAddress: true, region: true },
    })
    for (const o of overrides) {
      const region = o.region
      // null is meaningful (force unresolved); blank string is sloppy data.
      if (region === null) {
        overridesByAddress.set(o.providerAddress.toLowerCase(), null)
      } else if (typeof region === 'string' && isRegionId(region)) {
        overridesByAddress.set(o.providerAddress.toLowerCase(), region)
      }
      // Anything else: ignore the row, fall through to auto-resolve.
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'Region override read failed — proceeding without overrides'
    )
  }

  // Iterate every AKASH provider.
  const providers = await prisma.computeProvider.findMany({
    where: { providerType: 'AKASH' },
    select: {
      id: true,
      address: true,
      attributes: true,
      region: true,
      country: true,
    },
  })

  for (const p of providers) {
    summary.scanned++

    const akashlyticsRow = akashlyticsByAddress.get(p.address.toLowerCase())
    const meta: ProviderMetadata = akashlyticsRow
      ? metadataFromAkashlytics(akashlyticsRow)
      : metadataFromChainAttributes(p.attributes)

    const override = overridesByAddress.has(p.address.toLowerCase())
      ? overridesByAddress.get(p.address.toLowerCase())
      : undefined

    const result = resolveProviderRegion(meta, override)
    summary.bySource[result.source]++

    if (result.region) summary.resolved++
    else summary.unresolved++

    const nextRegion = result.region
    const nextCountry = result.country

    const regionChanged = (p.region ?? null) !== (nextRegion ?? null)
    const countryChanged = (p.country ?? null) !== (nextCountry ?? null)

    if (regionChanged || countryChanged) {
      try {
        await prisma.computeProvider.update({
          where: { id: p.id },
          data: {
            region: nextRegion,
            country: nextCountry,
          },
        })
        if (regionChanged) summary.changedRegion++
        if (countryChanged) summary.changedCountry++
      } catch (err) {
        log.warn(
          {
            err: err instanceof Error ? err.message : err,
            address: p.address,
          },
          'Region update failed for one provider — skipping'
        )
      }
    }
  }

  summary.durationMs = Date.now() - start

  log.info(
    {
      scanned: summary.scanned,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      changedRegion: summary.changedRegion,
      changedCountry: summary.changedCountry,
      bySource: summary.bySource,
      durationMs: summary.durationMs,
    },
    'Refreshed provider regions'
  )

  return summary
}
