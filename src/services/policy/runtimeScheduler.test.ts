import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  handlePolicyExpiry,
  scheduleOrEnforcePolicyExpiry,
} from './runtimeScheduler.js'

const { publishJobMock, stopForPolicyMock } = vi.hoisted(() => ({
  publishJobMock: vi.fn(),
  stopForPolicyMock: vi.fn(),
}))

vi.mock('../queue/qstashClient.js', () => ({
  isQStashEnabled: vi.fn(() => true),
  publishJob: publishJobMock,
}))

vi.mock('./enforcer.js', () => ({
  stopForPolicy: stopForPolicyMock,
}))

describe('runtimeScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('schedules a delayed expiry job for active deployments with future expiry', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    const prisma = {
      deploymentPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'policy-1',
          expiresAt,
          stopReason: null,
          akashDeployment: { id: 'akash-1', dseq: '1', status: 'ACTIVE' },
          phalaDeployment: null,
        }),
      },
    } as unknown as PrismaClient

    await scheduleOrEnforcePolicyExpiry(prisma, 'policy-1')

    expect(publishJobMock).toHaveBeenCalledWith(
      '/queue/policy/expire',
      expect.objectContaining({
        step: 'EXPIRE_POLICY',
        policyId: 'policy-1',
        expectedExpiresAt: expiresAt.toISOString(),
      }),
      expect.objectContaining({
        delaySec: expect.any(Number),
      })
    )
    expect(stopForPolicyMock).not.toHaveBeenCalled()
  })

  it('stops an already-expired active deployment immediately', async () => {
    const expiresAt = new Date(Date.now() - 60_000)
    const policy = {
      id: 'policy-2',
      expiresAt,
      stopReason: null,
      akashDeployment: { id: 'akash-2', dseq: '2', status: 'ACTIVE' },
      phalaDeployment: null,
    }
    const prisma = {
      deploymentPolicy: {
        findUnique: vi.fn().mockResolvedValue(policy),
      },
    } as unknown as PrismaClient

    await scheduleOrEnforcePolicyExpiry(prisma, 'policy-2')

    expect(stopForPolicyMock).toHaveBeenCalledWith(
      prisma,
      policy,
      'RUNTIME_EXPIRED'
    )
  })

  it('ignores stale expiry jobs after the policy expiry changed', async () => {
    const prisma = {
      deploymentPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'policy-3',
          expiresAt: new Date('2026-03-29T05:00:00.000Z'),
          stopReason: null,
          akashDeployment: { id: 'akash-3', dseq: '3', status: 'ACTIVE' },
          phalaDeployment: null,
        }),
      },
    } as unknown as PrismaClient

    await handlePolicyExpiry(prisma, {
      step: 'EXPIRE_POLICY',
      policyId: 'policy-3',
      expectedExpiresAt: '2026-03-29T04:00:00.000Z',
    })

    expect(stopForPolicyMock).not.toHaveBeenCalled()
  })
})
