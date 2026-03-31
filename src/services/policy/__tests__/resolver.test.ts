import { describe, test, expect } from 'vitest'
import { filterAkashBidsByPolicy, filterPhalaInstancesByPolicy } from '../resolver.js'
import type { DeploymentPolicyRecord } from '../types.js'

const makePolicy = (overrides: Partial<DeploymentPolicyRecord> = {}): DeploymentPolicyRecord => ({
  id: 'pol-1',
  acceptableGpuModels: [],
  gpuUnits: null,
  gpuVendor: null,
  maxBudgetUsd: null,
  maxMonthlyUsd: null,
  runtimeMinutes: null,
  expiresAt: null,
  stopReason: null,
  stoppedAt: null,
  totalSpentUsd: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('filterAkashBidsByPolicy', () => {
  const bids = [
    { provider: 'prov-a', gpuModel: 'h100' },
    { provider: 'prov-b', gpuModel: 'a100' },
    { provider: 'prov-c', gpuModel: 'rtx4090' },
    { provider: 'prov-d', gpuModel: null },
  ]

  test('returns all bids when no policy', () => {
    expect(filterAkashBidsByPolicy(bids, null)).toHaveLength(4)
  })

  test('returns all bids when policy has no GPU constraints', () => {
    expect(filterAkashBidsByPolicy(bids, makePolicy())).toHaveLength(4)
  })

  test('filters bids by acceptable GPU models', () => {
    const policy = makePolicy({ acceptableGpuModels: ['h100', 'a100'] })
    const result = filterAkashBidsByPolicy(bids, policy)
    expect(result).toHaveLength(2)
    expect(result.map(b => b.gpuModel)).toEqual(['h100', 'a100'])
  })

  test('handles case-insensitive matching', () => {
    const policy = makePolicy({ acceptableGpuModels: ['H100'] })
    const result = filterAkashBidsByPolicy(bids, policy)
    expect(result).toHaveLength(1)
    expect(result[0].gpuModel).toBe('h100')
  })

  test('excludes bids with no GPU model', () => {
    const policy = makePolicy({ acceptableGpuModels: ['h100'] })
    const result = filterAkashBidsByPolicy(bids, policy)
    expect(result.every(b => b.gpuModel != null)).toBe(true)
  })
})

describe('filterPhalaInstancesByPolicy', () => {
  const instances = [
    { gpu: 'h100', gpuCount: 1 },
    { gpu: 'h200', gpuCount: 1 },
    { gpu: 'h200', gpuCount: 8 },
    { gpu: null, gpuCount: null },
  ]

  test('returns all instances when no constraints', () => {
    expect(filterPhalaInstancesByPolicy(instances, [])).toHaveLength(4)
  })

  test('filters by acceptable GPU models', () => {
    const result = filterPhalaInstancesByPolicy(instances, ['h100'])
    expect(result).toHaveLength(1)
    expect(result[0].gpu).toBe('h100')
  })

  test('filters by GPU units', () => {
    const result = filterPhalaInstancesByPolicy(instances, [], 8)
    expect(result).toHaveLength(1)
    expect(result[0].gpuCount).toBe(8)
  })

  test('combines GPU model and units filter', () => {
    const result = filterPhalaInstancesByPolicy(instances, ['h200'], 8)
    expect(result).toHaveLength(1)
    expect(result[0].gpu).toBe('h200')
    expect(result[0].gpuCount).toBe(8)
  })

  test('returns empty when no match', () => {
    const result = filterPhalaInstancesByPolicy(instances, ['b200'])
    expect(result).toHaveLength(0)
  })
})
