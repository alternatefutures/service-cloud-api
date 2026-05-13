/**
 * Spheron region-bucket regex pinning.
 *
 * Pins the live cluster strings observed at 2026-05-13 against the four
 * Phase 46 buckets (`us-east`, `us-west`, `eu`, `asia`). Every cluster
 * string surfaced by the upstream `client.listGpuOffers` MUST match
 * exactly one bucket — otherwise it'll be invisible to region-filtered
 * queries (false negative → row missing from the dropdown when the user
 * picks that region).
 *
 * Update this fixture when a new cluster string surfaces, BEFORE shipping.
 * Phase 51 incident: "EU North 1", "US Central 1" and "CANADA-1" were
 * silently false-negative for ~3 days until a re-probe caught it.
 */
import { describe, it, expect } from 'vitest'
import { clusterMatchesBucket } from './offerPicker.js'

describe('clusterMatchesBucket — pinned live cluster strings', () => {
  describe('eu bucket', () => {
    const cases = [
      // Phase H discovery (2026-04-21)
      'Finland 3',
      'Iceland 1',
      'amsterdam-netherlands-2',
      'warsaw-poland-1',
      // Phase 51 re-probe (2026-05-13)
      'EU North 1',
      'EU West 1',
      'EU South 1',
      'EU Central 1',
      'eu-central-1',
    ]
    for (const cluster of cases) {
      it(`matches "${cluster}"`, () => {
        expect(clusterMatchesBucket(cluster, 'eu')).toBe(true)
        expect(clusterMatchesBucket(cluster, 'us-east')).toBe(false)
        expect(clusterMatchesBucket(cluster, 'us-west')).toBe(false)
        expect(clusterMatchesBucket(cluster, 'asia')).toBe(false)
      })
    }
  })

  describe('us-east bucket', () => {
    const cases = [
      // Phase H discovery
      'us-east-virginia-1',
      'Texas-1',
      'us-central-2',
      'us-central-3',
      'kansascity-usa-1',
      'desmoines-usa-1',
      'culpeper-usa-1',
      // Phase 51 re-probe
      'US Central 1',
      'CANADA-1',
      'montreal-canada-2',
    ]
    for (const cluster of cases) {
      it(`matches "${cluster}"`, () => {
        expect(clusterMatchesBucket(cluster, 'us-east')).toBe(true)
        expect(clusterMatchesBucket(cluster, 'eu')).toBe(false)
      })
    }
  })

  describe('us-west bucket', () => {
    const cases = [
      'California-1',
      'us-west-oregon-1',
      'san-francisco-1',
    ]
    for (const cluster of cases) {
      it(`matches "${cluster}"`, () => {
        expect(clusterMatchesBucket(cluster, 'us-west')).toBe(true)
        expect(clusterMatchesBucket(cluster, 'eu')).toBe(false)
      })
    }
  })

  describe('asia bucket', () => {
    const cases = [
      'singapore-1',
      'tokyo-japan-1',
      'mumbai-india-2',
      'sydney-australia-1',
      'ap-southeast-1',
    ]
    for (const cluster of cases) {
      it(`matches "${cluster}"`, () => {
        expect(clusterMatchesBucket(cluster, 'asia')).toBe(true)
        expect(clusterMatchesBucket(cluster, 'eu')).toBe(false)
      })
    }
  })

  it('null bucket accepts every cluster', () => {
    expect(clusterMatchesBucket('Finland 3', null)).toBe(true)
    expect(clusterMatchesBucket('CANADA-1', null)).toBe(true)
    expect(clusterMatchesBucket('anything', null)).toBe(true)
  })

  it('unknown bucket falls through to global (does not fail-closed)', () => {
    expect(clusterMatchesBucket('Finland 3', 'antarctica')).toBe(true)
  })
})
