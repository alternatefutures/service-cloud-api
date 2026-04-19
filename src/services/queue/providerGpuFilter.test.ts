import { beforeEach, describe, expect, it, vi } from 'vitest'

// `akashSteps.ts` pulls in heavy deps (qstash, billing, escrow). Mock
// the narrow surface needed for the helpers under test.
const { execAsyncMock } = vi.hoisted(() => ({ execAsyncMock: vi.fn() }))

vi.mock('./asyncExec.js', () => ({ execAsync: execAsyncMock }))
vi.mock('./qstashClient.js', () => ({
  isQStashEnabled: () => false,
  publishJob: vi.fn(),
}))
vi.mock('../billing/escrowService.js', () => ({
  getEscrowService: () => ({ createEscrow: vi.fn() }),
}))
vi.mock('../billing/billingApiClient.js', () => ({
  getBillingApiClient: () => ({ getOrgBilling: vi.fn(), getOrgMarkup: vi.fn() }),
}))

import {
  providerHasAcceptableGpu,
  resolveProviderGpuModels,
} from './akashSteps.js'

interface FakePrisma {
  computeProvider: { findFirst: ReturnType<typeof vi.fn> }
  akashDeployment: { findUnique: ReturnType<typeof vi.fn> }
}

function buildPrisma(opts: {
  verifiedGpuModels?: string[] | null
  sdlContent?: string | null
}): FakePrisma {
  return {
    computeProvider: {
      findFirst: vi.fn().mockResolvedValue(
        opts.verifiedGpuModels === undefined
          ? null
          : { gpuModels: opts.verifiedGpuModels ?? [] },
      ),
    },
    akashDeployment: {
      findUnique: vi.fn().mockResolvedValue(
        opts.sdlContent === undefined ? null : { sdlContent: opts.sdlContent ?? '' },
      ),
    },
  }
}

beforeEach(() => {
  execAsyncMock.mockReset()
})

describe('resolveProviderGpuModels', () => {
  it('returns the verified set from compute_provider when present (multiple models)', async () => {
    // Real-world case: provider exposes both H100 and A100. The old
    // resolver returned only the first chain attribute (h100), causing
    // an a100-only policy to reject this provider's bid.
    const prisma = buildPrisma({ verifiedGpuModels: ['h100', 'a100'] })
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models.sort()).toEqual(['a100', 'h100'])
    expect(prisma.akashDeployment.findUnique).not.toHaveBeenCalled()
    expect(execAsyncMock).not.toHaveBeenCalled()
  })

  it('lowercases verified-set entries', async () => {
    const prisma = buildPrisma({ verifiedGpuModels: ['H100', 'A100'] })
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models.sort()).toEqual(['a100', 'h100'])
  })

  it('falls through to SDL parsing when verified set is empty', async () => {
    const prisma = buildPrisma({
      verifiedGpuModels: [],
      sdlContent: 'profiles:\n  compute:\n    svc:\n      resources:\n        gpu:\n          units: 1\n          attributes:\n            vendor:\n              nvidia:\n                - model: a100\n',
    })
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models).toEqual(['a100'])
    expect(execAsyncMock).not.toHaveBeenCalled()
  })

  it('ignores SDL when model is wildcard or vendor-only', async () => {
    const prisma = buildPrisma({
      verifiedGpuModels: [],
      sdlContent: 'gpu:\n  attributes:\n    vendor:\n      nvidia:\n',
    })
    execAsyncMock.mockResolvedValueOnce(
      JSON.stringify({
        attributes: [
          { key: 'capabilities/gpu/vendor/nvidia/model/h100', value: 'true' },
        ],
      }),
    )
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models).toEqual(['h100'])
  })

  it('extracts ALL chain GPU attributes (multi-GPU rig)', async () => {
    const prisma = buildPrisma({ verifiedGpuModels: [], sdlContent: null })
    execAsyncMock.mockResolvedValueOnce(
      JSON.stringify({
        provider: {
          attributes: [
            { key: 'region', value: 'us-west' },
            { key: 'capabilities/gpu/vendor/nvidia/model/h100', value: 'true' },
            { key: 'capabilities/gpu/vendor/nvidia/model/a100', value: 'true' },
            { key: 'capabilities/gpu/vendor/nvidia/model/rtx5090', value: 'true' },
          ],
        },
      }),
    )
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models.sort()).toEqual(['a100', 'h100', 'rtx5090'])
  })

  it('returns empty array when chain query fails', async () => {
    const prisma = buildPrisma({ verifiedGpuModels: [], sdlContent: null })
    execAsyncMock.mockRejectedValueOnce(new Error('chain unreachable'))
    const models = await resolveProviderGpuModels(
      'akash1...',
      prisma as never,
      'dep-1',
    )
    expect(models).toEqual([])
  })
})

describe('providerHasAcceptableGpu', () => {
  it('returns the matched model when verified set intersects acceptable (the milady-A100 case)', async () => {
    // Provider exposes both H100 and A100; user's policy demands A100.
    // Before the fix this returned null; now it returns 'a100'.
    const prisma = buildPrisma({ verifiedGpuModels: ['h100', 'a100'] })
    const matched = await providerHasAcceptableGpu(
      'akash1...',
      new Set(['a100']),
      prisma as never,
      'dep-1',
    )
    expect(matched).toBe('a100')
  })

  it('returns null when none of the provider GPUs are acceptable', async () => {
    const prisma = buildPrisma({ verifiedGpuModels: ['rtx4090', 'rtx5090'] })
    const matched = await providerHasAcceptableGpu(
      'akash1...',
      new Set(['a100', 'h200']),
      prisma as never,
      'dep-1',
    )
    expect(matched).toBeNull()
  })

  it('matches when policy contains multiple acceptable models and provider has any of them', async () => {
    const prisma = buildPrisma({ verifiedGpuModels: ['rtx5090'] })
    const matched = await providerHasAcceptableGpu(
      'akash1...',
      new Set(['a100', 'h200', 'rtx5090']),
      prisma as never,
      'dep-1',
    )
    expect(matched).toBe('rtx5090')
  })
})
