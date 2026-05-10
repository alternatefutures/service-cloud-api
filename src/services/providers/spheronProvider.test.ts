/**
 * Spheron provider adapter tests — focused on the lifecycle-safety contracts
 * the sweeper depends on (Phase 31 / 49 / 49b):
 *
 *   1. `getCapabilities` matches the locked feature matrix (no native stop,
 *      log streaming via SSH, custom config format).
 *   2. `getHealth` mappings — 'gone' is reserved for confirmed-dead VMs;
 *      'unhealthy' is reserved for crashed-container; SSH transient errors
 *      return 'unknown', NEVER 'healthy' on catch.
 *   3. `close` swallows isAlreadyGone, defers on isMinimumRuntimeNotMet.
 *   4. `stop` and `deploy(serviceId, options)` both throw — they're
 *      typed-entry-point-only by design.
 *
 * Mocks the orchestrator + the Prisma model. Every assertion either pins a
 * locked decision from `AF_IMPLEMENTATION_SPHERON.md` or a Phase 50 bug-fix
 * boundary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const {
  closeDeploymentMock,
  getDeploymentStatusMock,
  probeDeploymentExistenceMock,
  getDockerHealthViaSshMock,
} = vi.hoisted(() => ({
  closeDeploymentMock: vi.fn(),
  getDeploymentStatusMock: vi.fn(),
  probeDeploymentExistenceMock: vi.fn(),
  getDockerHealthViaSshMock: vi.fn(),
}))

vi.mock('../spheron/orchestrator.js', () => ({
  getSpheronOrchestrator: () => ({
    closeDeployment: closeDeploymentMock,
    getDeploymentStatus: getDeploymentStatusMock,
    probeDeploymentExistence: probeDeploymentExistenceMock,
    getDockerHealthViaSsh: getDockerHealthViaSshMock,
  }),
}))

vi.mock('../billing/deploymentSettlement.js', () => ({
  processFinalSpheronBilling: vi.fn(),
}))

vi.mock('../../lib/opsAlert.js', () => ({
  opsAlert: vi.fn(() => Promise.resolve()),
}))

import { SpheronApiError } from '../spheron/client.js'
import { SpheronProvider } from './spheronProvider.js'

function makePrisma(deployment: any) {
  return {
    spheronDeployment: {
      findUnique: vi.fn(async () => deployment),
      findMany: vi.fn(async () => [deployment].filter(Boolean)),
      update: vi.fn(async () => undefined),
    },
    deploymentPolicy: {
      update: vi.fn(async () => undefined),
    },
  } as unknown as PrismaClient
}

const baseRow = {
  id: 'dep-1',
  name: 'svc-1',
  status: 'ACTIVE' as const,
  providerDeploymentId: 'sph-abc',
  ipAddress: '1.2.3.4',
  sshUser: 'ubuntu',
  sshPort: 22,
  policyId: null as string | null,
  errorMessage: null as string | null,
  activeStartedAt: new Date(Date.now() - 5 * 60 * 1000), // 5min ago
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SpheronProvider — capabilities + isAvailable', () => {
  it('isAvailable() flips on SPHERON_API_KEY presence', () => {
    const prisma = makePrisma(null)
    const provider = new SpheronProvider(prisma)
    delete process.env.SPHERON_API_KEY
    expect(provider.isAvailable()).toBe(false)
    process.env.SPHERON_API_KEY = 'sai_pk_test'
    expect(provider.isAvailable()).toBe(true)
    delete process.env.SPHERON_API_KEY
  })

  it('getCapabilities matches the locked feature matrix', () => {
    const provider = new SpheronProvider(makePrisma(null))
    expect(provider.getCapabilities()).toEqual({
      supportsStop: false,
      supportsLogStreaming: true,
      supportsTEE: false,
      supportsPersistentStorage: true,
      supportsWebSocket: true,
      supportsShell: true,
      configFormat: 'custom',
      billingModel: 'hourly',
    })
  })
})

describe('SpheronProvider — generic deploy/stop entry points throw', () => {
  it('deploy(serviceId, options) throws (typed entry-point-only)', async () => {
    const provider = new SpheronProvider(makePrisma(null))
    await expect(provider.deploy('svc-1', {} as any)).rejects.toThrow(/typed offer selection/)
  })

  it('stop(deploymentId) throws (Spheron has no native stop)', async () => {
    const provider = new SpheronProvider(makePrisma(null))
    await expect(provider.stop('dep-1')).rejects.toThrow(/Spheron does not support stop/)
  })
})

describe('SpheronProvider.getHealth — verdict matrix (Phase 49 / 49b)', () => {
  it('DELETED → "unknown" (already-settled, sweeper must NOT act)', async () => {
    const prisma = makePrisma({ ...baseRow, status: 'DELETED' })
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
  })

  it('FAILED → "gone" (sweeper close_gone path syncs row)', async () => {
    const prisma = makePrisma({ ...baseRow, status: 'FAILED' })
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('PERMANENTLY_FAILED → "gone" (Phase 49b terminal mapping)', async () => {
    const prisma = makePrisma({ ...baseRow, status: 'PERMANENTLY_FAILED' })
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('CREATING / STARTING → "starting"', async () => {
    for (const status of ['CREATING', 'STARTING'] as const) {
      const prisma = makePrisma({ ...baseRow, status })
      const result = await new SpheronProvider(prisma).getHealth('dep-1')
      expect(result?.overall).toBe('starting')
    }
  })

  it('STOPPED → "unknown" (resumable, NOT a sweeper signal)', async () => {
    const prisma = makePrisma({ ...baseRow, status: 'STOPPED' })
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
  })

  it('ACTIVE + missing providerDeploymentId → "unknown" (race window)', async () => {
    const prisma = makePrisma({ ...baseRow, providerDeploymentId: null })
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
    expect(result?.containers[0]?.message).toMatch(/providerDeploymentId not yet persisted/)
  })

  it('ACTIVE + upstream status=terminated → "gone"', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'terminated' })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('ACTIVE + upstream status=terminated-provider → "gone" (SPOT-reclaim placeholder)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'terminated-provider' })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('ACTIVE + upstream status=failed → "gone"', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'failed' })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('ACTIVE + upstream status=deploying → "starting"', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'deploying' })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('starting')
  })

  it('ACTIVE + upstream running + all containers running → "healthy"', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'running' })
    getDockerHealthViaSshMock.mockResolvedValueOnce({
      allRunning: true,
      containers: [{ name: 'app', state: 'running', status: 'Up 5 min' }],
    })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('healthy')
  })

  it('ACTIVE + upstream running + some containers crashed → "unhealthy" (Phase 49: NOT a close signal)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'running' })
    getDockerHealthViaSshMock.mockResolvedValueOnce({
      allRunning: false,
      containers: [
        { name: 'app', state: 'running', status: 'Up 5 min' },
        { name: 'sidecar', state: 'exited', status: 'Exited (1) 2 min ago' },
      ],
    })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unhealthy')
  })

  it('ACTIVE + upstream running + SSH null (transient) → "unknown" (NEVER fakes healthy)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'running' })
    getDockerHealthViaSshMock.mockResolvedValueOnce(null)
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
    expect(result?.containers[0]?.message).toMatch(/SSH probe transiently failed/)
  })

  it('ACTIVE + upstream null + probe="gone" → "gone" (Phase 49b upgrade path)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce(null)
    probeDeploymentExistenceMock.mockResolvedValueOnce('gone')
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('ACTIVE + upstream null + probe="unknown" → "unknown" (transient stays transient)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce(null)
    probeDeploymentExistenceMock.mockResolvedValueOnce('unknown')
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
  })

  it('ACTIVE + 404 thrown → "gone" directly (we have evidence)', async () => {
    getDeploymentStatusMock.mockRejectedValueOnce(
      new SpheronApiError('not found', 404),
    )
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
    expect(result?.containers[0]?.message).toMatch(/404/)
  })

  it('ACTIVE + non-404 error + probe="gone" → "gone"', async () => {
    getDeploymentStatusMock.mockRejectedValueOnce(new Error('network'))
    probeDeploymentExistenceMock.mockResolvedValueOnce('gone')
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('gone')
  })

  it('ACTIVE + non-404 error + probe throws → "unknown" (defensive)', async () => {
    getDeploymentStatusMock.mockRejectedValueOnce(new Error('network'))
    probeDeploymentExistenceMock.mockRejectedValueOnce(new Error('probe down'))
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
  })

  it('ACTIVE + unrecognised native status → "unknown" (forward-compat)', async () => {
    getDeploymentStatusMock.mockResolvedValueOnce({ status: 'paused-by-provider' })
    const prisma = makePrisma(baseRow)
    const result = await new SpheronProvider(prisma).getHealth('dep-1')
    expect(result?.overall).toBe('unknown')
    expect(result?.containers[0]?.message).toMatch(/Unrecognised Spheron status/)
  })
})

describe('SpheronProvider.close — idempotency + minimum-runtime deferral', () => {
  it('returns early on DELETED (no upstream call, no double-billing)', async () => {
    const prisma = makePrisma({ ...baseRow, status: 'DELETED' })
    const provider = new SpheronProvider(prisma)
    await provider.close('dep-1')
    expect(closeDeploymentMock).not.toHaveBeenCalled()
  })

  it('swallows isAlreadyGone (Phase 50 already-terminated regex fix)', async () => {
    closeDeploymentMock.mockRejectedValueOnce(
      new SpheronApiError('Instance has already been terminated', 400, undefined, {
        currentStatus: 'terminated',
      }),
    )
    const prisma = makePrisma(baseRow)
    const provider = new SpheronProvider(prisma)
    await expect(provider.close('dep-1')).resolves.toBeUndefined()
    expect(prisma.spheronDeployment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DELETED',
          upstreamDeletedAt: expect.any(Date),
        }),
      }),
    )
  })

  it('defers upstream cleanup on isMinimumRuntimeNotMet (sweeper retries)', async () => {
    // SpheronApiError(message, status, code?, details?) — `details` carries
    // the structured payload that isMinimumRuntimeNotMet() inspects.
    // Spheron returns timeRemaining in MINUTES (matches the message regex
    // and the upstream API observation noted in client.ts:248-252).
    closeDeploymentMock.mockRejectedValueOnce(
      new SpheronApiError(
        'Instance must run for at least 20 minutes. Time remaining: 12 minutes.',
        400,
        undefined,
        { canTerminate: false, timeRemaining: 12, minimumRuntime: 20 },
      ),
    )
    const prisma = makePrisma(baseRow)
    const provider = new SpheronProvider(prisma)
    await expect(provider.close('dep-1')).resolves.toBeUndefined()
    // Local row marked DELETED but upstreamDeletedAt left null so sweeper retries.
    const updateCall = (prisma.spheronDeployment.update as any).mock.calls[0]?.[0]
    expect(updateCall?.data?.status).toBe('DELETED')
    expect(updateCall?.data?.upstreamDeletedAt).toBeUndefined()
  })

  it('rethrows non-recoverable upstream errors', async () => {
    closeDeploymentMock.mockRejectedValueOnce(
      new SpheronApiError('Internal server error', 500),
    )
    const prisma = makePrisma(baseRow)
    const provider = new SpheronProvider(prisma)
    await expect(provider.close('dep-1')).rejects.toThrow(/Internal server error/)
  })
})
