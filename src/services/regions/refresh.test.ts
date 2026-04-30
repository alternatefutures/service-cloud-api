import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  metadataFromAkashlytics,
  metadataFromChainAttributes,
  normalizeCountry,
  refreshProviderRegions,
  type AkashlyticsProviderRow,
} from './refresh.js'

describe('normalizeCountry', () => {
  it('passes through 2-letter ISO codes lowercased', () => {
    expect(normalizeCountry('US')).toBe('us')
    expect(normalizeCountry('de')).toBe('de')
  })

  it('maps full country names to ISO', () => {
    expect(normalizeCountry('United States')).toBe('us')
    expect(normalizeCountry('Germany')).toBe('de')
    expect(normalizeCountry('Singapore')).toBe('sg')
  })

  it('returns null for unknown / blank', () => {
    expect(normalizeCountry('Atlantis')).toBeNull()
    expect(normalizeCountry('')).toBeNull()
    expect(normalizeCountry(null)).toBeNull()
    expect(normalizeCountry(undefined)).toBeNull()
  })
})

describe('metadataFromAkashlytics', () => {
  it('pulls lat/lon, region, country, host from a typical row', () => {
    const row: AkashlyticsProviderRow = {
      owner: 'akash1abc',
      hostUri: 'provider.us-west.example.com',
      ipRegion: 'us-west-2',
      ipCountry: 'US',
      ipLat: 37.77,
      ipLon: -122.42,
    }
    const meta = metadataFromAkashlytics(row)
    expect(meta.lat).toBe(37.77)
    expect(meta.lon).toBe(-122.42)
    expect(meta.region).toBe('us-west-2')
    expect(meta.country).toBe('us')
    expect(meta.host).toBe('provider.us-west.example.com')
  })

  it('coerces stringified numbers in lat/lon', () => {
    const meta = metadataFromAkashlytics({
      ipLat: '37.77' as any,
      ipLon: '-122.42' as any,
    })
    expect(meta.lat).toBe(37.77)
    expect(meta.lon).toBe(-122.42)
  })

  it('falls back to attributes[] when ipRegion/ipCountry are absent', () => {
    const row: AkashlyticsProviderRow = {
      attributes: [
        { key: 'region', value: 'eu-central-1' },
        { key: 'country', value: 'de' },
      ],
    }
    const meta = metadataFromAkashlytics(row)
    expect(meta.region).toBe('eu-central-1')
    expect(meta.country).toBe('de')
  })

  it('returns nulls cleanly when nothing is available', () => {
    const meta = metadataFromAkashlytics({})
    expect(meta.lat).toBeNull()
    expect(meta.lon).toBeNull()
    expect(meta.region).toBeNull()
    expect(meta.country).toBeNull()
    expect(meta.host).toBeNull()
  })
})

describe('metadataFromChainAttributes', () => {
  it('handles array shape', () => {
    const meta = metadataFromChainAttributes([
      { key: 'region', value: 'eu-west' },
      { key: 'country', value: 'NL' },
      { key: 'host', value: 'host.eu.example.com' },
    ])
    expect(meta.region).toBe('eu-west')
    expect(meta.country).toBe('nl')
    expect(meta.host).toBe('host.eu.example.com')
  })

  it('handles flat object shape', () => {
    const meta = metadataFromChainAttributes({
      region: 'us-east-1',
      country: 'United States',
      host: 'foo.us-east.network',
    })
    expect(meta.region).toBe('us-east-1')
    expect(meta.country).toBe('us')
    expect(meta.host).toBe('foo.us-east.network')
  })

  it('returns all-nulls for non-objects', () => {
    expect(metadataFromChainAttributes(null)).toEqual({
      lat: null,
      lon: null,
      region: null,
      country: null,
      host: null,
    })
    expect(metadataFromChainAttributes('not an object')).toEqual({
      lat: null,
      lon: null,
      region: null,
      country: null,
      host: null,
    })
  })
})

// ── refreshProviderRegions integration-ish (mocked Prisma + fetcher) ───────

interface MockProvider {
  id: string
  address: string
  attributes: any
  region: string | null
  country: string | null
}

function buildMockPrisma(
  providers: MockProvider[],
  overrides: Array<{ providerAddress: string; region: string | null }> = []
) {
  const updates: Array<{
    id: string
    data: { region: string | null; country: string | null }
  }> = []
  return {
    updates,
    prisma: {
      computeProvider: {
        findMany: vi.fn().mockResolvedValue(providers),
        update: vi.fn(async ({ where, data }: any) => {
          updates.push({ id: where.id, data })
          // Mutate the in-memory copy so subsequent reads see the change.
          const p = providers.find((x) => x.id === where.id)
          if (p) {
            if ('region' in data) p.region = data.region
            if ('country' in data) p.country = data.country
          }
          return p
        }),
      },
      computeProviderRegionOverride: {
        findMany: vi.fn().mockResolvedValue(overrides),
      },
    } as any,
  }
}

describe('refreshProviderRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes region+country when previously null', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1west',
        attributes: null,
        region: null,
        country: null,
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers)
    const fetcher = vi.fn(async () => [
      {
        owner: 'akash1west',
        ipLat: 37.77,
        ipLon: -122.42,
        ipCountry: 'US',
        ipRegion: 'us-west-2',
      },
    ])

    const summary = await refreshProviderRegions(prisma, fetcher)

    expect(summary.scanned).toBe(1)
    expect(summary.resolved).toBe(1)
    expect(summary.changedRegion).toBe(1)
    expect(summary.changedCountry).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0].data.region).toBe('us-west')
    expect(updates[0].data.country).toBe('us')
    expect(summary.bySource.akashlytics_latlon).toBe(1)
  })

  it('does not write when region+country are unchanged', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1west',
        attributes: null,
        region: 'us-west',
        country: 'us',
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers)
    const fetcher = vi.fn(async () => [
      {
        owner: 'akash1west',
        ipLat: 37.77,
        ipLon: -122.42,
        ipCountry: 'US',
      },
    ])

    const summary = await refreshProviderRegions(prisma, fetcher)
    expect(summary.changedRegion).toBe(0)
    expect(summary.changedCountry).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('falls back to chain attributes when Akashlytics is empty', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1eu',
        attributes: { region: 'eu-central-1', country: 'de' },
        region: null,
        country: null,
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers)
    const fetcher = vi.fn(async () => [])

    const summary = await refreshProviderRegions(prisma, fetcher)
    expect(summary.resolved).toBe(1)
    expect(updates[0].data.region).toBe('eu')
    expect(updates[0].data.country).toBe('de')
    expect(summary.bySource.akashlytics_latlon).toBe(0)
  })

  it('respects a manual override even when Akashlytics says otherwise', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1west',
        attributes: null,
        region: null,
        country: null,
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers, [
      { providerAddress: 'akash1west', region: 'eu' },
    ])
    const fetcher = vi.fn(async () => [
      {
        owner: 'akash1west',
        ipLat: 37.77,
        ipLon: -122.42,
        ipCountry: 'US',
      },
    ])

    const summary = await refreshProviderRegions(prisma, fetcher)
    expect(updates[0].data.region).toBe('eu')
    expect(summary.bySource.manual_override).toBe(1)
  })

  it('manual override of null forces unresolved', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1west',
        attributes: null,
        region: 'us-west',
        country: 'us',
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers, [
      { providerAddress: 'akash1west', region: null },
    ])
    const fetcher = vi.fn(async () => [
      {
        owner: 'akash1west',
        ipLat: 37.77,
        ipLon: -122.42,
        ipCountry: 'US',
      },
    ])

    await refreshProviderRegions(prisma, fetcher)
    expect(updates[0].data.region).toBeNull()
  })

  it('survives per-provider update failures without aborting the run', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1one',
        attributes: null,
        region: null,
        country: null,
      },
      {
        id: 'p2',
        address: 'akash1two',
        attributes: null,
        region: null,
        country: null,
      },
    ]
    const { prisma } = buildMockPrisma(providers)
    // Make the first update throw, second succeed.
    let callCount = 0
    prisma.computeProvider.update = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw new Error('db connection lost momentarily')
      return providers[1]
    }) as any
    const fetcher = vi.fn(async () => [
      { owner: 'akash1one', ipLat: 37.77, ipLon: -122.42, ipCountry: 'US' },
      { owner: 'akash1two', ipLat: 50.11, ipLon: 8.68, ipCountry: 'DE' },
    ])

    const summary = await refreshProviderRegions(prisma, fetcher)
    expect(summary.scanned).toBe(2)
    // Both resolved; only one wrote successfully but neither aborted.
    expect(summary.resolved).toBe(2)
  })

  it('survives a totally failing Akashlytics fetcher', async () => {
    const providers: MockProvider[] = [
      {
        id: 'p1',
        address: 'akash1eu',
        attributes: { region: 'eu' },
        region: null,
        country: null,
      },
    ]
    const { prisma, updates } = buildMockPrisma(providers)
    const fetcher = vi.fn(async () => {
      throw new Error('ENETUNREACH')
    })

    const summary = await refreshProviderRegions(prisma, fetcher)
    // Falls back to chain attributes, still resolves the one provider.
    expect(summary.resolved).toBe(1)
    expect(updates[0].data.region).toBe('eu')
  })
})
