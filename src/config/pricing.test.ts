import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  PRICING,
  STORAGE_PRICING,
  REGISTRY_PRICING,
  calculateStorageCost,
  calculateBandwidthCost,
  calculateComputeCost,
  calculateRegistryCost,
  getPricingInfo,
  getAkashChainGeometry,
  _resetAkashChainGeometryCacheForTests,
} from './pricing'

describe('Pricing Configuration', () => {
  describe('PRICING constants', () => {
    it('should have correct IPFS storage price', () => {
      expect(PRICING.storage.ipfs).toBe(STORAGE_PRICING.ipfs.ratePerGb)
    })

    it('should have correct Filecoin storage price', () => {
      expect(PRICING.storage.filecoin).toBe(STORAGE_PRICING.filecoin.ratePerGb)
    })

    it('should have correct Arweave storage price', () => {
      expect(PRICING.storage.arweave).toBe(STORAGE_PRICING.arweave.ratePerGb)
    })

    it('should have correct bandwidth pricing', () => {
      expect(PRICING.bandwidth.free.included).toBe(100)
      expect(PRICING.bandwidth.free.overage).toBe(0.1)
      expect(PRICING.bandwidth.pro.included).toBe(1024)
      expect(PRICING.bandwidth.pro.overage).toBe(0.08)
    })

    it('should have correct compute pricing', () => {
      expect(PRICING.compute.agentRuntime).toBe(0.05)
      expect(PRICING.compute.functionInvocations).toBe(0.2)
      expect(PRICING.compute.gpuProcessing).toBe(0.5)
    })

    it('should have correct registry pricing', () => {
      expect(PRICING.registry.storage).toBe(REGISTRY_PRICING.storage)
      expect(PRICING.registry.database).toBe(REGISTRY_PRICING.database)
      expect(PRICING.registry.compute).toBe(REGISTRY_PRICING.compute)
    })
  })

  describe('calculateStorageCost', () => {
    it('should calculate IPFS cost correctly', () => {
      const rate = STORAGE_PRICING.ipfs.ratePerGb
      expect(calculateStorageCost('ipfs', 10, 1)).toBe(10 * rate)
    })

    it('should calculate IPFS cost for multiple months', () => {
      const rate = STORAGE_PRICING.ipfs.ratePerGb
      expect(calculateStorageCost('ipfs', 5, 3)).toBeCloseTo(5 * 3 * rate, 2)
    })

    it('should calculate Filecoin cost correctly', () => {
      expect(calculateStorageCost('filecoin', 100, 1)).toBe(3.0)
    })

    it('should calculate Arweave one-time cost correctly', () => {
      const rate = STORAGE_PRICING.arweave.ratePerGb
      expect(calculateStorageCost('arweave', 2)).toBe(2 * rate)
    })

    it('should ignore months parameter for Arweave', () => {
      const rate = STORAGE_PRICING.arweave.ratePerGb
      expect(calculateStorageCost('arweave', 2, 12)).toBe(2 * rate)
    })
  })

  describe('calculateBandwidthCost', () => {
    it('should return 0 for usage within free tier limit', () => {
      expect(calculateBandwidthCost('free', 50)).toBe(0)
      expect(calculateBandwidthCost('free', 100)).toBe(0)
    })

    it('should calculate overage cost for free tier', () => {
      expect(calculateBandwidthCost('free', 150)).toBe(5.0)
    })

    it('should return 0 for usage within pro tier limit', () => {
      expect(calculateBandwidthCost('pro', 500)).toBe(0)
      expect(calculateBandwidthCost('pro', 1024)).toBe(0)
    })

    it('should calculate overage cost for pro tier', () => {
      expect(calculateBandwidthCost('pro', 1524)).toBe(40.0)
    })

    it('should return 0 for enterprise tier (custom pricing)', () => {
      expect(calculateBandwidthCost('enterprise', 10000)).toBe(0)
    })
  })

  describe('calculateComputeCost', () => {
    it('should calculate agent runtime cost', () => {
      expect(calculateComputeCost('agentRuntime', 24)).toBeCloseTo(1.2, 2)
    })

    it('should calculate function invocations cost', () => {
      expect(calculateComputeCost('functionInvocations', 5)).toBe(1.0)
    })

    it('should calculate GPU processing cost', () => {
      expect(calculateComputeCost('gpuProcessing', 10)).toBe(5.0)
    })
  })

  describe('calculateRegistryCost', () => {
    it('should calculate monthly registry cost', () => {
      const expected =
        50 * REGISTRY_PRICING.storage +
        5 * REGISTRY_PRICING.database +
        730 * REGISTRY_PRICING.compute
      expect(calculateRegistryCost(50, 5, 730)).toBeCloseTo(expected, 2)
    })

    it('should use default 730 hours for 24/7 operation', () => {
      const cost = calculateRegistryCost(10, 1)
      const expected =
        10 * REGISTRY_PRICING.storage +
        1 * REGISTRY_PRICING.database +
        730 * REGISTRY_PRICING.compute
      expect(cost).toBeCloseTo(expected, 2)
    })

    it('should calculate partial month registry cost', () => {
      const cost = calculateRegistryCost(100, 10, 168)
      const expected =
        100 * REGISTRY_PRICING.storage +
        10 * REGISTRY_PRICING.database +
        168 * REGISTRY_PRICING.compute
      expect(cost).toBeCloseTo(expected, 2)
    })
  })

  describe('getPricingInfo', () => {
    it('should return formatted pricing information', () => {
      const info = getPricingInfo()

      expect(info.storage).toHaveLength(4)
      expect(info.storage[0]).toEqual({
        network: 'IPFS',
        type: 'Per GB/month',
        price: STORAGE_PRICING.ipfs.ratePerGb,
      })

      expect(info.bandwidth).toHaveLength(3)
      expect(info.compute).toHaveLength(3)
      expect(info.registry).toHaveLength(3)
    })

    it('should have correct IPFS pricing in info', () => {
      const info = getPricingInfo()
      const ipfsStorage = info.storage.find(s => s.network === 'IPFS')
      expect(ipfsStorage?.price).toBe(STORAGE_PRICING.ipfs.ratePerGb)
    })
  })

  describe('getAkashChainGeometry persistence/hydration', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
      _resetAkashChainGeometryCacheForTests()
    })

    afterEach(() => {
      global.fetch = originalFetch
      vi.restoreAllMocks()
      _resetAkashChainGeometryCacheForTests()
    })

    function makeBlocksResponse() {
      // Synthesise 12 samples (function requires ≥10) at 6.0s/block, most-
      // recent-first, so head − tail spans 11 × 100 blocks at 600s each.
      const headHeight = 21_500_000
      const headEpochMs = Date.parse('2026-04-19T12:00:00Z')
      const samples = Array.from({ length: 12 }, (_, i) => ({
        height: headHeight - i * 100,
        datetime: new Date(headEpochMs - i * 600_000).toISOString(),
      }))
      return new Response(JSON.stringify(samples), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    it('upserts chain_stats when prisma is provided and a fresh sample lands', async () => {
      global.fetch = vi.fn().mockResolvedValue(makeBlocksResponse())
      const upsert = vi.fn().mockResolvedValue({})
      const findUnique = vi.fn()
      const prisma = { chainStats: { upsert, findUnique } } as any

      const geom = await getAkashChainGeometry(prisma)

      expect(geom.source).toBe('akash-console-api')
      expect(upsert).toHaveBeenCalledTimes(1)
      const call = upsert.mock.calls[0][0]
      expect(call.where).toEqual({ id: 'akash-mainnet' })
      expect(call.create.id).toBe('akash-mainnet')
      expect(call.create.blocksPerDay).toBe(geom.blocksPerDay)
      // Hydration query should not have been needed when live API succeeded.
      expect(findUnique).not.toHaveBeenCalled()
    })

    it('hydrates from chain_stats on cold-start when both cache and live API are unavailable', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'))
      const upsert = vi.fn()
      const findUnique = vi.fn().mockResolvedValue({
        id: 'akash-mainnet',
        secondsPerBlock: 6.117,
        blocksPerHour: 588,
        blocksPerDay: 14_124,
        sourceUrl: 'https://console-api.akash.network/v1/blocks',
        sampledAt: new Date('2026-04-19T10:00:00Z'),
      })
      const prisma = { chainStats: { upsert, findUnique } } as any

      const geom = await getAkashChainGeometry(prisma)

      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'akash-mainnet' } })
      expect(geom.source).toBe('cache')
      expect(geom.blocksPerDay).toBe(14_124)
      expect(geom.secondsPerBlock).toBeCloseTo(6.117, 3)
    })

    it('falls back to the static constant when live API fails AND no chain_stats row exists', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'))
      const prisma = {
        chainStats: {
          upsert: vi.fn(),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as any

      const geom = await getAkashChainGeometry(prisma)
      expect(geom.source).toBe('static-fallback')
      expect(geom.blocksPerDay).toBeGreaterThan(0)
    })

    it('does not throw when persistence to chain_stats fails', async () => {
      global.fetch = vi.fn().mockResolvedValue(makeBlocksResponse())
      const upsert = vi.fn().mockRejectedValue(new Error('db down'))
      const prisma = {
        chainStats: { upsert, findUnique: vi.fn() },
      } as any

      const geom = await getAkashChainGeometry(prisma)
      expect(geom.source).toBe('akash-console-api')
      expect(upsert).toHaveBeenCalled()
    })

    it('works without a prisma argument (in-memory cache only)', async () => {
      global.fetch = vi.fn().mockResolvedValue(makeBlocksResponse())
      const geom = await getAkashChainGeometry()
      expect(geom.source).toBe('akash-console-api')
      expect(geom.blocksPerDay).toBeGreaterThan(0)
    })
  })
})
