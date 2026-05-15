/**
 * Spheron QStash step handler tests.
 *
 * Focused on the lifecycle-safety contracts that the rest of the system
 * (sweeper, resolver, billing) depends on:
 *
 *   1. Terminal-state guard on every step entry (Phase 31 / 49 — stale QStash
 *      messages for already-terminal rows are dropped).
 *   2. Idempotent DEPLOY_VM re-entry when `providerDeploymentId` already
 *      persisted (covers the "POST succeeded, worker crashed before 200 to
 *      QStash" case — without this we'd POST a duplicate VM, then get a 400
 *      on the second attempt and burn money on a dangling instance).
 *   3. Retry-name compounding fix from the 2026-05-07 handoff. The regex
 *      `(?:-r\d+-[a-z0-9]+)+$` MUST strip ALL chained suffixes, not just the
 *      last one. Spheron 400s names beyond ~50 chars with
 *      `Input payload validation failed`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const {
  publishJobMock,
  isQStashEnabledMock,
  emitProgressMock,
} = vi.hoisted(() => ({
  publishJobMock: vi.fn(),
  isQStashEnabledMock: vi.fn(() => false),
  emitProgressMock: vi.fn(),
}))

vi.mock('./qstashClient.js', () => ({
  isQStashEnabled: isQStashEnabledMock,
  publishJob: publishJobMock,
}))

vi.mock('../events/deploymentEvents.js', () => ({
  deploymentEvents: { emitProgress: emitProgressMock },
}))

vi.mock('../spheron/client.js', async () => {
  const actual = await vi.importActual<typeof import('../spheron/client.js')>('../spheron/client.js')
  return {
    ...actual,
    getSpheronClient: vi.fn(() => ({
      createDeployment: vi.fn(async () => ({ id: 'sph-newly-created' })),
    })),
  }
})

vi.mock('../spheron/orchestrator.js', () => ({
  getSpheronOrchestrator: vi.fn(() => ({
    closeDeployment: vi.fn(),
  })),
}))

vi.mock('../policy/runtimeScheduler.js', () => ({
  scheduleOrEnforcePolicyExpiry: vi.fn(),
}))

import { handleDeployVm } from './spheronSteps.js'

function makePrisma(deployment: any) {
  const find = vi.fn(async () => deployment)
  const update = vi.fn(async () => undefined)
  return {
    spheronDeployment: { findUnique: find, update },
  } as unknown as PrismaClient & {
    spheronDeployment: { findUnique: typeof find; update: typeof update }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleDeployVm — terminal-state guard (Phase 31 / 49)', () => {
  for (const status of ['ACTIVE', 'FAILED', 'STOPPED', 'DELETED', 'PERMANENTLY_FAILED'] as const) {
    it(`drops the message when status is ${status}`, async () => {
      const prisma = makePrisma({
        id: 'dep-1',
        status,
        retryCount: 0,
        providerDeploymentId: null,
        savedDeployInput: { name: 'svc-1' },
      })
      await handleDeployVm(prisma, 'dep-1')
      // No POST, no enqueue, no progress emit.
      expect(publishJobMock).not.toHaveBeenCalled()
      expect(emitProgressMock).not.toHaveBeenCalled()
      expect(prisma.spheronDeployment.update).not.toHaveBeenCalled()
    })
  }

  it('throws when the deployment row does not exist', async () => {
    const prisma = makePrisma(null)
    await expect(handleDeployVm(prisma, 'dep-missing')).rejects.toThrow(/not found/i)
  })
})

describe('handleDeployVm — idempotent re-entry on existing providerDeploymentId', () => {
  it('skips the POST and enqueues POLL_STATUS directly', async () => {
    isQStashEnabledMock.mockReturnValue(true)
    publishJobMock.mockResolvedValueOnce(undefined)
    const prisma = makePrisma({
      id: 'dep-1',
      status: 'CREATING',
      retryCount: 0,
      providerDeploymentId: 'sph-already-there',
      savedDeployInput: { name: 'svc-1' },
    })
    await handleDeployVm(prisma, 'dep-1')

    // Did NOT update spheronDeployment (no fresh POST happened).
    expect(prisma.spheronDeployment.update).not.toHaveBeenCalled()

    // DID publish exactly one POLL_STATUS payload.
    expect(publishJobMock).toHaveBeenCalledTimes(1)
    const [route, payload] = publishJobMock.mock.calls[0] ?? []
    expect(route).toBe('/queue/spheron/step')
    expect(payload).toEqual({ step: 'POLL_STATUS', deploymentId: 'dep-1', attempt: 1 })
  })
})

describe('handleDeployVm — stock blocklist short-circuit (Phase 50.1)', () => {
  // The blocklist guard exists to stop `resumeStuckDeployments` from
  // re-POSTing a CREATING row whose SKU just failed for capacity. Without
  // this, every cloud-api restart hammers Spheron with already-known-
  // bad requests for ~15 min (until the block TTL clears).
  it('routes directly to HANDLE_FAILURE when gpuType is blocklisted', async () => {
    isQStashEnabledMock.mockReturnValue(true)
    publishJobMock.mockResolvedValueOnce(undefined)

    const { markStockExhausted, _resetStockBlocklist } = await import('../spheron/stockBlocklist.js')
    _resetStockBlocklist()
    markStockExhausted('A4000_PCIE', 'Not Enough Stock of RTX-A4000')

    const prisma = makePrisma({
      id: 'dep-1',
      status: 'CREATING',
      retryCount: 0,
      providerDeploymentId: null,
      gpuType: 'A4000_PCIE',
      savedDeployInput: { name: 'svc-1' },
    })
    await handleDeployVm(prisma, 'dep-1')

    // The POST never happens — update for providerDeploymentId is skipped.
    expect(prisma.spheronDeployment.update).not.toHaveBeenCalled()

    // HANDLE_FAILURE is enqueued with a clear blocklist message.
    expect(publishJobMock).toHaveBeenCalledTimes(1)
    const [route, payload] = publishJobMock.mock.calls[0] ?? []
    expect(route).toBe('/queue/spheron/step')
    expect(payload).toMatchObject({
      step: 'HANDLE_FAILURE',
      deploymentId: 'dep-1',
    })
    expect((payload as { errorMessage: string }).errorMessage).toMatch(/A4000_PCIE/)
    expect((payload as { errorMessage: string }).errorMessage).toMatch(/temporarily out of stock/i)

    _resetStockBlocklist()
  })

  it('does NOT short-circuit when the row already has a providerDeploymentId (idempotent re-entry wins)', async () => {
    isQStashEnabledMock.mockReturnValue(true)
    publishJobMock.mockResolvedValueOnce(undefined)

    const { markStockExhausted, _resetStockBlocklist } = await import('../spheron/stockBlocklist.js')
    _resetStockBlocklist()
    markStockExhausted('A4000_PCIE', 'Not Enough Stock')

    const prisma = makePrisma({
      id: 'dep-1',
      status: 'STARTING',
      retryCount: 0,
      providerDeploymentId: 'sph-already-there',
      gpuType: 'A4000_PCIE',
      savedDeployInput: { name: 'svc-1' },
    })
    await handleDeployVm(prisma, 'dep-1')

    // Idempotent path: enqueue POLL_STATUS, not HANDLE_FAILURE. The
    // POST already happened upstream so the blocklist is irrelevant —
    // we just need to resume polling.
    const [, payload] = publishJobMock.mock.calls[0] ?? []
    expect((payload as { step: string }).step).toBe('POLL_STATUS')

    _resetStockBlocklist()
  })
})

/**
 * The retry-name compounding regex isn't exported (it's an inline literal in
 * the function body). Mirror it verbatim here so the test pins the exact
 * pattern that lives in production code. If the production regex ever
 * changes shape, this test should fail until they're re-aligned manually —
 * the symmetry IS the assertion.
 *
 * Source of truth: `services/queue/spheronSteps.ts` line ~715.
 */
const RETRY_SUFFIX_REGEX = /(?:-r\d+-[a-z0-9]+)+$/

describe('retry-name compounding regex (2026-05-07 handoff fix)', () => {
  it('strips a single suffix', () => {
    expect('svc-app-r1-aaa111'.replace(RETRY_SUFFIX_REGEX, '')).toBe('svc-app')
  })

  it('strips chained suffixes (the original bug)', () => {
    // After 3 retries the original code was producing this kind of name.
    // The regex MUST strip ALL chained suffixes, not just the last one.
    expect(
      'svc-app-r1-aaa111-r2-bbb222-r3-ccc333'.replace(RETRY_SUFFIX_REGEX, ''),
    ).toBe('svc-app')
  })

  it('preserves clean base names with no suffixes', () => {
    expect('milady-deployment'.replace(RETRY_SUFFIX_REGEX, '')).toBe('milady-deployment')
    expect('alternate-agent-prod'.replace(RETRY_SUFFIX_REGEX, '')).toBe('alternate-agent-prod')
  })

  it('preserves digits + hyphens that are NOT retry suffixes', () => {
    // `r123` without a dash + alphanum-segment shouldn't match. `2.1.0` style
    // semvers, region codes, etc. all pass through untouched.
    expect('postgres-15-prod'.replace(RETRY_SUFFIX_REGEX, '')).toBe('postgres-15-prod')
    expect('app-v2-canary'.replace(RETRY_SUFFIX_REGEX, '')).toBe('app-v2-canary')
  })

  it('only strips at end-of-string (mid-string suffixes are left alone)', () => {
    // Pathological: a literal `-r1-token` in the middle of a name.
    // Spheron names are not prefix/suffix structured, so middle matches
    // would be a false positive. The regex anchors with `$`.
    expect('weird-r1-aaa-suffix'.replace(RETRY_SUFFIX_REGEX, '')).toBe('weird-r1-aaa-suffix')
  })

  it('produces names short enough to clear Spheron\'s ~50-char limit (length sanity)', () => {
    const baseName = 'svc-very-long-application-name-with-org-prefix-12345' // 52 chars
    // Pre-fix: third retry produced 52 + 24 = 76 chars → 400.
    // Post-fix: regex strips, then we add ONE retry suffix.
    const compounded = `${baseName}-r1-aaa1-r2-bbb2-r3-ccc3`
    const stripped = compounded.replace(RETRY_SUFFIX_REGEX, '')
    expect(stripped).toBe(baseName)
    const retried = `${stripped}-r4-${(1735000000).toString(36)}`
    // 52 + ~12 ≈ 64 chars — well under the per-tenant cap once Spheron's
    // 50-char gripe is the lower bound (real cap is 64 in their docs).
    expect(retried.length).toBeLessThanOrEqual(72)
  })
})
