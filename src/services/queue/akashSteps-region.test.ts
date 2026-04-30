import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const {
  execAsyncMock,
  publishJobMock,
  ensureFreshMock,
} = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
  publishJobMock: vi.fn(),
  ensureFreshMock: vi.fn(),
}))

vi.mock('./asyncExec.js', () => ({
  execAsync: execAsyncMock,
}))

vi.mock('./qstashClient.js', () => ({
  isQStashEnabled: vi.fn(() => true),
  publishJob: publishJobMock,
}))

vi.mock('../akash/providerSelector.js', () => ({
  providerSelector: {
    ensureFresh: ensureFreshMock,
    getSafeBids: vi.fn(() => []),
    selectPreferredBid: vi.fn(() => null),
    isProviderVerified: vi.fn(() => false),
  },
}))

vi.mock('../akash/orchestrator.js', () => ({
  DEFAULT_DEPOSIT_UACT: 1_000_000,
  getAkashOrchestrator: vi.fn(() => ({})),
}))

vi.mock('../billing/escrowService.js', () => ({
  getEscrowService: vi.fn(() => ({})),
}))

vi.mock('../billing/billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({})),
}))

vi.mock('../policy/runtimeScheduler.js', () => ({
  scheduleOrEnforcePolicyExpiry: vi.fn(),
}))

import { handleCheckBids } from './akashSteps.js'
import { BID_POLL_MAX_ATTEMPTS } from '../../config/akash.js'

function buildPrisma(deployment: any) {
  const update = vi.fn(async ({ data }: any) => ({ ...deployment, ...data }))
  return {
    update,
    prisma: {
      akashDeployment: {
        findUnique: vi.fn(async () => deployment),
        update,
      },
    } as unknown as PrismaClient,
  }
}

describe('handleCheckBids — Phase 46 region branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AKASH_MNEMONIC = 'test mnemonic'
    // Empty bids — drives the empty-bids branch.
    execAsyncMock.mockResolvedValue(JSON.stringify({ bids: [] }))
  })

  it('routes to AWAITING_REGION_RESPONSE when region is set and bids exhausted', async () => {
    const { prisma, update } = buildPrisma({
      id: 'dep-1',
      owner: 'akash1owner',
      dseq: 100n,
      retryCount: 0,
      status: 'WAITING_BIDS',
      excludedProviders: [],
      region: 'us-east',
    })

    await handleCheckBids(prisma, {
      step: 'CHECK_BIDS',
      deploymentId: 'dep-1',
      attempt: BID_POLL_MAX_ATTEMPTS,
    })

    // Status should have been updated to AWAITING_REGION_RESPONSE
    const statusUpdate = update.mock.calls.find(
      (call) =>
        (call[0] as any).data?.status === 'AWAITING_REGION_RESPONSE'
    )
    expect(statusUpdate).toBeDefined()
    expect((statusUpdate![0] as any).data.errorMessage).toContain('us-east')

    // HANDLE_FAILURE must NOT have been enqueued
    const handleFailureCalls = publishJobMock.mock.calls.filter(
      (call) => (call[1] as any)?.step === 'HANDLE_FAILURE'
    )
    expect(handleFailureCalls).toHaveLength(0)
  })

  it('routes to HANDLE_FAILURE (legacy path) when region is null and bids exhausted', async () => {
    const { prisma, update } = buildPrisma({
      id: 'dep-2',
      owner: 'akash1owner',
      dseq: 200n,
      retryCount: 0,
      status: 'WAITING_BIDS',
      excludedProviders: [],
      region: null,
    })

    await handleCheckBids(prisma, {
      step: 'CHECK_BIDS',
      deploymentId: 'dep-2',
      attempt: BID_POLL_MAX_ATTEMPTS,
    })

    // Should NOT have been moved to AWAITING_REGION_RESPONSE
    const regionStatusUpdate = update.mock.calls.find(
      (call) =>
        (call[0] as any).data?.status === 'AWAITING_REGION_RESPONSE'
    )
    expect(regionStatusUpdate).toBeUndefined()

    // HANDLE_FAILURE should have been enqueued
    const handleFailureCalls = publishJobMock.mock.calls.filter(
      (call) => (call[1] as any)?.step === 'HANDLE_FAILURE'
    )
    expect(handleFailureCalls).toHaveLength(1)
    expect(handleFailureCalls[0][1]).toMatchObject({
      step: 'HANDLE_FAILURE',
      deploymentId: 'dep-2',
      errorMessage: 'No bids received within timeout',
    })
  })

  it('keeps polling (does not trigger region branch) when attempts not exhausted', async () => {
    const { prisma, update } = buildPrisma({
      id: 'dep-3',
      owner: 'akash1owner',
      dseq: 300n,
      retryCount: 0,
      status: 'WAITING_BIDS',
      excludedProviders: [],
      region: 'eu',
    })

    await handleCheckBids(prisma, {
      step: 'CHECK_BIDS',
      deploymentId: 'dep-3',
      attempt: 1, // way below BID_POLL_MAX_ATTEMPTS
    })

    // Status should NOT change to AWAITING_REGION_RESPONSE on early attempt
    const regionStatusUpdate = update.mock.calls.find(
      (call) =>
        (call[0] as any).data?.status === 'AWAITING_REGION_RESPONSE'
    )
    expect(regionStatusUpdate).toBeUndefined()

    // Should re-enqueue CHECK_BIDS instead
    const checkBidsCalls = publishJobMock.mock.calls.filter(
      (call) => (call[1] as any)?.step === 'CHECK_BIDS'
    )
    expect(checkBidsCalls).toHaveLength(1)
  })
})
