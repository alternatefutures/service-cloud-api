import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const {
  execAsyncMock,
  publishJobMock,
  createEscrowMock,
  getOrgBillingMock,
  getOrgMarkupMock,
  scheduleExpiryMock,
} = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
  publishJobMock: vi.fn(),
  createEscrowMock: vi.fn(),
  getOrgBillingMock: vi.fn(),
  getOrgMarkupMock: vi.fn(),
  scheduleExpiryMock: vi.fn(),
}))

vi.mock('./asyncExec.js', () => ({
  execAsync: execAsyncMock,
}))

vi.mock('./qstashClient.js', () => ({
  isQStashEnabled: vi.fn(() => true),
  publishJob: publishJobMock,
}))

vi.mock('../billing/escrowService.js', () => ({
  getEscrowService: vi.fn(() => ({
    createEscrow: createEscrowMock,
  })),
}))

vi.mock('../billing/billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({
    getOrgBilling: getOrgBillingMock,
    getOrgMarkup: getOrgMarkupMock,
  })),
}))

vi.mock('../policy/runtimeScheduler.js', () => ({
  scheduleOrEnforcePolicyExpiry: scheduleExpiryMock,
}))

import { finalizeDeployment, handlePollUrls } from './akashSteps.js'

describe('finalizeDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AKASH_MNEMONIC = 'test mnemonic'

    getOrgBillingMock.mockResolvedValue({
      orgBillingId: 'org-billing-1',
    })
    getOrgMarkupMock.mockResolvedValue({
      marginRate: 0.25,
    })
  })

  it('fails activation instead of marking deployment active when escrow creation fails', async () => {
    createEscrowMock.mockRejectedValue(new Error('billing api unavailable'))

    const prisma = {
      akashDeployment: {
        update: vi.fn(),
      },
    } as unknown as PrismaClient

    await expect(
      finalizeDeployment(
        prisma,
        {
          id: 'dep-1',
          dseq: 123n,
          provider: 'akash-provider',
          pricePerBlock: '2000',
          sdlContent: 'services:\n  app:\n    image: example/app:latest\n',
          retryCount: 0,
          status: 'DEPLOYING',
          policyId: 'policy-1',
          gpuModel: 'nvidia-rtx4090',
          service: {
            slug: 'milady-gateway-vlxk',
            type: 'CONTAINER',
            createdByUserId: 'user-1',
            project: {
              organizationId: 'org-1',
            },
            afFunction: null,
            site: null,
          },
        },
        {
          app: { uris: ['test.example.com'] },
        }
      )
    ).rejects.toThrow('billing api unavailable')

    expect(prisma.akashDeployment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACTIVE',
        }),
      })
    )
    expect(scheduleExpiryMock).not.toHaveBeenCalled()
  })

  it('marks deployment active after escrow is created successfully', async () => {
    createEscrowMock.mockResolvedValue({
      id: 'escrow-1',
    })

    const prisma = {
      akashDeployment: {
        update: vi.fn(),
      },
    } as unknown as PrismaClient

    await finalizeDeployment(
      prisma,
      {
        id: 'dep-2',
        dseq: 456n,
        provider: 'akash-provider',
        pricePerBlock: '2000',
        sdlContent: 'services:\n  app:\n    image: example/app:v1\n',
        retryCount: 0,
        status: 'DEPLOYING',
        policyId: 'policy-2',
        gpuModel: 'nvidia-rtx4090',
        service: {
          slug: 'active-service',
          type: 'CONTAINER',
          createdByUserId: 'user-2',
          project: {
            organizationId: 'org-2',
          },
          afFunction: null,
          site: null,
        },
      },
      {
        app: { uris: ['test.example.com'] },
      }
    )

    expect(createEscrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        akashDeploymentId: 'dep-2',
        organizationId: 'org-2',
        pricePerBlock: '2000',
      })
    )
    expect(prisma.akashDeployment.update).toHaveBeenCalledWith({
      where: { id: 'dep-2' },
      data: expect.objectContaining({
        status: 'ACTIVE',
        serviceUrls: {
          app: { uris: ['test.example.com'] },
        },
      }),
    })
    expect(scheduleExpiryMock).toHaveBeenCalledWith(prisma, 'policy-2')
  })

  it('routes escrow activation failures into HANDLE_FAILURE from POLL_URLS', async () => {
    execAsyncMock.mockResolvedValue(
      JSON.stringify({
        services: {
          app: {
            uris: ['test.example.com'],
            available_replicas: 1,
          },
        },
      })
    )
    createEscrowMock.mockRejectedValue(new Error('billing api unavailable'))

    const prisma = {
      akashDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'dep-3',
          dseq: 789n,
          provider: 'akash-provider',
          pricePerBlock: '2000',
          sdlContent: 'services:\n  app:\n    image: example/app:v3\n',
          retryCount: 0,
          status: 'DEPLOYING',
          policyId: 'policy-3',
          gpuModel: 'nvidia-rtx4090',
          service: {
            slug: 'queued-service',
            type: 'CONTAINER',
            createdByUserId: 'user-3',
            project: {
              organizationId: 'org-3',
            },
            afFunction: null,
            site: null,
          },
        }),
        update: vi.fn(),
      },
    } as unknown as PrismaClient

    await handlePollUrls(prisma, {
      step: 'POLL_URLS',
      deploymentId: 'dep-3',
      attempt: 1,
    })

    expect(prisma.akashDeployment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACTIVE',
        }),
      })
    )
    expect(publishJobMock).toHaveBeenCalledTimes(1)
    expect(publishJobMock.mock.calls[0]?.[0]).toBe('/queue/akash/step')
    expect(publishJobMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        step: 'HANDLE_FAILURE',
        deploymentId: 'dep-3',
        errorMessage: expect.stringContaining('billing api unavailable'),
      })
    )
    expect(scheduleExpiryMock).not.toHaveBeenCalled()
  })
})
