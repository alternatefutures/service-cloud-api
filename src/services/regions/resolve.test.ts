import { describe, it, expect } from 'vitest'
import {
  resolveProviderRegion,
  nearestCentroid,
  type ProviderMetadata,
} from './resolve.js'

describe('nearestCentroid', () => {
  it('buckets DC area to us-east', () => {
    expect(nearestCentroid({ lat: 38.9, lon: -77.0 })).toBe('us-east')
  })

  it('buckets San Francisco to us-west', () => {
    expect(nearestCentroid({ lat: 37.77, lon: -122.42 })).toBe('us-west')
  })

  it('buckets Frankfurt to eu', () => {
    expect(nearestCentroid({ lat: 50.11, lon: 8.68 })).toBe('eu')
  })

  it('buckets Tokyo to asia', () => {
    expect(nearestCentroid({ lat: 35.68, lon: 139.69 })).toBe('asia')
  })

  it('buckets Singapore to asia', () => {
    expect(nearestCentroid({ lat: 1.35, lon: 103.82 })).toBe('asia')
  })

  it('buckets London to eu (closest curated centroid)', () => {
    expect(nearestCentroid({ lat: 51.5, lon: -0.1 })).toBe('eu')
  })

  it('returns null for NaN coords', () => {
    expect(nearestCentroid({ lat: NaN, lon: 0 })).toBeNull()
    expect(nearestCentroid({ lat: 0, lon: NaN })).toBeNull()
  })

  it('returns null for out-of-range coords', () => {
    expect(nearestCentroid({ lat: 95, lon: 0 })).toBeNull()
    expect(nearestCentroid({ lat: 0, lon: 200 })).toBeNull()
  })
})

describe('resolveProviderRegion — Akashlytics lat/lon (priority 1)', () => {
  it('beats every other signal when present', () => {
    // Lat/lon says us-west, but country and region attr say us-east — lat/lon wins.
    const result = resolveProviderRegion({
      lat: 37.77,
      lon: -122.42,
      region: 'us-east-1',
      country: 'us',
    })
    expect(result.region).toBe('us-west')
    expect(result.source).toBe('akashlytics_latlon')
    expect(result.country).toBe('us')
  })

  it('falls through when lat/lon is invalid', () => {
    const result = resolveProviderRegion({
      lat: NaN,
      lon: 999,
      region: 'us-east-1',
    })
    expect(result.region).toBe('us-east')
    expect(result.source).toBe('chain_region_alias')
  })
})

describe('resolveProviderRegion — chain region alias (priority 2)', () => {
  it('matches `us-east-1` to us-east', () => {
    const result = resolveProviderRegion({ region: 'us-east-1' })
    expect(result.region).toBe('us-east')
    expect(result.source).toBe('chain_region_alias')
  })

  it('matches `eu-central-1` to eu', () => {
    const result = resolveProviderRegion({ region: 'eu-central-1' })
    expect(result.region).toBe('eu')
  })

  it('matches `ap-southeast-2` to asia', () => {
    const result = resolveProviderRegion({ region: 'ap-southeast-2' })
    expect(result.region).toBe('asia')
  })

  it('is case-insensitive', () => {
    expect(resolveProviderRegion({ region: 'EU-WEST' }).region).toBe('eu')
  })

  it('prefers longer (more specific) alias matches', () => {
    // `us-east` and `east` both exist as aliases; `us-east` should win
    // because we sort by length descending.
    expect(resolveProviderRegion({ region: 'us-east-1' }).source).toBe(
      'chain_region_alias'
    )
  })
})

describe('resolveProviderRegion — chain country (priority 3)', () => {
  it('maps `de` to eu unambiguously', () => {
    const result = resolveProviderRegion({ country: 'de' })
    expect(result.region).toBe('eu')
    expect(result.source).toBe('chain_country')
  })

  it('maps `jp` to asia', () => {
    expect(resolveProviderRegion({ country: 'jp' }).region).toBe('asia')
  })

  it('maps bare `us` to us-east (default tiebreak with no lat/lon)', () => {
    const result = resolveProviderRegion({ country: 'us' })
    expect(result.region).toBe('us-east')
    expect(result.source).toBe('chain_country')
  })

  it('maps `us` with western lon to us-west via lat/lon tiebreak', () => {
    // No actual lat (so we don't trigger priority 1), but lon is set.
    const result = resolveProviderRegion({
      country: 'us',
      lon: -120,
      lat: null, // explicitly null — priority 1 needs both
    })
    expect(result.region).toBe('us-west')
    expect(result.source).toBe('chain_country')
  })

  it('maps `us` with eastern lon to us-east via tiebreak', () => {
    const result = resolveProviderRegion({
      country: 'us',
      lon: -75,
      lat: null,
    })
    expect(result.region).toBe('us-east')
    expect(result.source).toBe('chain_country')
  })
})

describe('resolveProviderRegion — chain host heuristic (priority 4)', () => {
  it('matches `provider.us-east.example.com` to us-east', () => {
    const result = resolveProviderRegion({
      host: 'provider.us-east.example.com',
    })
    expect(result.region).toBe('us-east')
    expect(result.source).toBe('chain_host')
  })

  it('matches `host.eu-central.akash.network` to eu', () => {
    const result = resolveProviderRegion({
      host: 'host.eu-central.akash.network',
    })
    expect(result.region).toBe('eu')
  })

  it('matches `apac.example.com` to asia', () => {
    expect(
      resolveProviderRegion({ host: 'apac.example.com' }).region
    ).toBe('asia')
  })

  it('falls through when no heuristic matches', () => {
    const result = resolveProviderRegion({
      host: 'random-name.example.com',
    })
    expect(result.region).toBeNull()
    expect(result.source).toBe('unresolved')
  })
})

describe('resolveProviderRegion — manual override (priority 5, special)', () => {
  it('beats every auto-resolved signal', () => {
    const result = resolveProviderRegion(
      {
        lat: 37.77,
        lon: -122.42,
        region: 'us-west',
        country: 'us',
      },
      'eu' // manual override says eu, even though everything else is us-west
    )
    expect(result.region).toBe('eu')
    expect(result.source).toBe('manual_override')
  })

  it('explicit null override forces unresolved', () => {
    const result = resolveProviderRegion(
      { lat: 37.77, lon: -122.42 },
      null // operator hid the auto-resolve
    )
    expect(result.region).toBeNull()
    expect(result.source).toBe('manual_override')
  })

  it('undefined override (no row) does NOT force unresolved', () => {
    // `undefined` means "no row in the override table" — don't short-circuit.
    const result = resolveProviderRegion(
      { lat: 37.77, lon: -122.42 },
      undefined
    )
    expect(result.region).toBe('us-west')
    expect(result.source).toBe('akashlytics_latlon')
  })
})

describe('resolveProviderRegion — unresolved (priority 6)', () => {
  it('returns null with no metadata', () => {
    const result = resolveProviderRegion({})
    expect(result.region).toBeNull()
    expect(result.source).toBe('unresolved')
    expect(result.country).toBeNull()
  })

  it('returns null with only an unmatched country', () => {
    const result = resolveProviderRegion({ country: 'br' }) // Brazil — not in any bucket
    expect(result.region).toBeNull()
    expect(result.source).toBe('unresolved')
    expect(result.country).toBe('br')
  })

  it('preserves country in the result even when unresolved', () => {
    const result = resolveProviderRegion({ country: 'br', host: 'something' })
    expect(result.country).toBe('br')
  })
})

describe('resolveProviderRegion — country handling', () => {
  it('lowercases country in the result regardless of input case', () => {
    const result = resolveProviderRegion({ country: 'DE' })
    expect(result.country).toBe('de')
    expect(result.region).toBe('eu')
  })

  it('preserves resolved country when lat/lon takes priority', () => {
    const result = resolveProviderRegion({
      lat: 37.77,
      lon: -122.42,
      country: 'us',
    })
    expect(result.region).toBe('us-west')
    expect(result.country).toBe('us')
  })
})
