import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock pricing helpers BEFORE importing the resolver so the in-memory
// caches inside `config/pricing` don't try to fetch the real Akash API.
vi.mock('../config/pricing.js', () => ({
  getAkashChainGeometry: vi.fn(async () => ({
    secondsPerBlock: 6.117,
    blocksPerHour: 588,
    blocksPerDay: 14_124,
    source: 'static-fallback' as const,
    sampledAt: Date.now(),
  })),
  getAktUsdPrice: vi.fn(async () => 1.5),
}))

import { regionsQueries } from './regions.js'

interface MockProvider {
  region: string | null
  verified: boolean
  isOnline: boolean
}

interface MockBid {
  providerRegion: string | null
  gpuModel: string
  pricePerBlock: bigint
}

function buildPrisma(providers: MockProvider[], bids: MockBid[] = []) {
  return {
    computeProvider: {
      findMany: vi.fn(async () => providers),
    },
    gpuBidObservation: {
      findMany: vi.fn(async () => bids),
    },
  } as any
}

describe('regions(provider: AKASH)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns one row per curated bucket in stable order', async () => {
    const prisma = buildPrisma([])
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    expect(result.map((r) => r.id)).toEqual([
      'us-east',
      'us-west',
      'eu',
      'asia',
    ])
    expect(result.every((r) => r.label.length > 0)).toBe(true)
  })

  it('default provider is AKASH (no arg)', async () => {
    const prisma = buildPrisma([])
    const result = await regionsQueries.regions(undefined, undefined, { prisma })
    expect(result.length).toBe(4)
    expect(result[0].id).toBe('us-east')
  })

  it('counts verified + online providers per region', async () => {
    const prisma = buildPrisma([
      { region: 'us-east', verified: true, isOnline: true },
      { region: 'us-east', verified: true, isOnline: false },
      { region: 'us-east', verified: false, isOnline: true },
      { region: 'eu', verified: true, isOnline: true },
    ])
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    const usEast = result.find((r) => r.id === 'us-east')!
    const eu = result.find((r) => r.id === 'eu')!
    const usWest = result.find((r) => r.id === 'us-west')!

    expect(usEast.verifiedCount).toBe(2)
    expect(usEast.onlineCount).toBe(2)
    expect(eu.verifiedCount).toBe(1)
    expect(eu.onlineCount).toBe(1)
    expect(usWest.verifiedCount).toBe(0)
  })

  it('default gate: available iff verified ≥ 1 (recent bids drive confidence, not availability)', async () => {
    delete process.env.AF_REGIONS_REQUIRE_BIDS

    // Reset module to re-evaluate the env-driven constant. vitest caches
    // the module so just clearing env isn't enough — but since the env
    // is read at import time, we have to re-import.
    vi.resetModules()
    const { regionsQueries: fresh } = await import('./regions.js')

    const prisma = buildPrisma(
      [
        { region: 'us-east', verified: true, isOnline: true },
        { region: 'eu', verified: true, isOnline: true },
        { region: 'us-west', verified: true, isOnline: true },
      ],
      [
        // Only us-east and eu have recent bids
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n },
        { providerRegion: 'eu', gpuModel: 'h100', pricePerBlock: 200n },
      ]
    )
    const result = await fresh.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    // All three with verified providers are selectable, regardless of bid history.
    expect(result.find((r) => r.id === 'us-east')!.available).toBe(true)
    expect(result.find((r) => r.id === 'eu')!.available).toBe(true)
    expect(result.find((r) => r.id === 'us-west')!.available).toBe(true)
    // No verified providers → unavailable regardless.
    expect(result.find((r) => r.id === 'asia')!.available).toBe(false)
    // But the no-bids region should still report RED confidence.
    expect(result.find((r) => r.id === 'us-west')!.confidence).toBe('RED')
  })

  it('strict gate (AF_REGIONS_REQUIRE_BIDS=1): available requires verified ≥ 1 AND recentBidCount ≥ 1', async () => {
    process.env.AF_REGIONS_REQUIRE_BIDS = '1'
    vi.resetModules()
    const { regionsQueries: strict } = await import('./regions.js')

    const prisma = buildPrisma(
      [
        { region: 'us-east', verified: true, isOnline: true },
        { region: 'eu', verified: true, isOnline: true },
        { region: 'us-west', verified: true, isOnline: true },
      ],
      [
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n },
        { providerRegion: 'eu', gpuModel: 'h100', pricePerBlock: 200n },
      ]
    )
    const result = await strict.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    expect(result.find((r) => r.id === 'us-east')!.available).toBe(true)
    expect(result.find((r) => r.id === 'eu')!.available).toBe(true)
    expect(result.find((r) => r.id === 'us-west')!.available).toBe(false) // no bids
    expect(result.find((r) => r.id === 'asia')!.available).toBe(false)

    delete process.env.AF_REGIONS_REQUIRE_BIDS
    vi.resetModules()
  })

  it('PHALA returns sentinel row, never queries DB', async () => {
    const prisma = buildPrisma([])
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'PHALA' },
      { prisma }
    )
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('phala-single-region')
    expect(result[0].available).toBe(false)
    expect(result[0].confidence).toBe('RED')
    expect(result[0].label).toContain('Phala')
    expect(prisma.computeProvider.findMany).not.toHaveBeenCalled()
    expect(prisma.gpuBidObservation.findMany).not.toHaveBeenCalled()
  })

  it('confidence GREEN when ≥3 verified + ≥3 bids', async () => {
    const prisma = buildPrisma(
      [
        { region: 'us-east', verified: true, isOnline: true },
        { region: 'us-east', verified: true, isOnline: true },
        { region: 'us-east', verified: true, isOnline: true },
      ],
      [
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n },
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 110n },
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 120n },
      ]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    expect(result.find((r) => r.id === 'us-east')!.confidence).toBe('GREEN')
  })

  it('confidence YELLOW when 1-2 verified providers but ≥1 bid', async () => {
    const prisma = buildPrisma(
      [{ region: 'us-east', verified: true, isOnline: true }],
      [{ providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n }]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    expect(result.find((r) => r.id === 'us-east')!.confidence).toBe('YELLOW')
  })

  it('confidence RED when no recent bids', async () => {
    const prisma = buildPrisma([
      { region: 'us-east', verified: true, isOnline: true },
    ])
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    expect(result.find((r) => r.id === 'us-east')!.confidence).toBe('RED')
  })

  it('computes median GPU price per region in USD/hr', async () => {
    const prisma = buildPrisma(
      [{ region: 'us-east', verified: true, isOnline: true }],
      [
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n },
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 200n },
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 300n },
      ]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    const usEast = result.find((r) => r.id === 'us-east')!
    // median(100, 200, 300) = 200 uact/block
    // × 588 blocks/hr ÷ 1e6 (uact→ACT) × $1.50 = ~$0.176/hr
    const h100 = usEast.medianPrices.h100
    expect(h100).not.toBeNull()
    expect(h100!).toBeGreaterThan(0.15)
    expect(h100!).toBeLessThan(0.20)
  })

  it('returns null for GPU models with no recent bids in region', async () => {
    const prisma = buildPrisma(
      [{ region: 'us-east', verified: true, isOnline: true }],
      [{ providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n }]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    const usEast = result.find((r) => r.id === 'us-east')!
    expect(usEast.medianPrices.h100).not.toBeNull()
    expect(usEast.medianPrices.h200).toBeNull()
    expect(usEast.medianPrices.a100).toBeNull()
    expect(usEast.medianPrices.rtx4090).toBeNull()
  })

  it('treats non-GPU bids as cpu1Core baseline', async () => {
    const prisma = buildPrisma(
      [{ region: 'eu', verified: true, isOnline: true }],
      [
        { providerRegion: 'eu', gpuModel: 'cpu', pricePerBlock: 50n },
        { providerRegion: 'eu', gpuModel: 'none', pricePerBlock: 60n },
      ]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    const eu = result.find((r) => r.id === 'eu')!
    expect(eu.medianPrices.cpu1Core).not.toBeNull()
    expect(eu.medianPrices.cpu1Core!).toBeGreaterThan(0)
  })

  it('ignores providers/bids tagged with regions outside the curated set', async () => {
    const prisma = buildPrisma(
      [
        { region: 'us-east', verified: true, isOnline: true },
        { region: 'mars-1', verified: true, isOnline: true } as any,
      ],
      [
        { providerRegion: 'us-east', gpuModel: 'h100', pricePerBlock: 100n },
        { providerRegion: 'mars-1', gpuModel: 'h100', pricePerBlock: 999n } as any,
      ]
    )
    const result = await regionsQueries.regions(
      undefined,
      { provider: 'AKASH' },
      { prisma }
    )
    // 'mars-1' didn't show up in the curated set — should be ignored entirely.
    expect(result.length).toBe(4)
    expect(result.find((r) => r.id === 'us-east')!.verifiedCount).toBe(1)
  })
})
