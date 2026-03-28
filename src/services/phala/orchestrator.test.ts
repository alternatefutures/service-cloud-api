import { describe, it, expect, vi, beforeEach } from 'vitest'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PhalaOrchestrator } from './orchestrator.js'
import type { PrismaClient } from '@prisma/client'

function createMockSpawn(stdout: string, exitCode = 0) {
  const proc = new EventEmitter() as any
  proc.stdio = ['ignore', null, null]
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout))
    proc.emit('close', exitCode)
  }, 0)
  return proc
}

function createFailingSpawn() {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setTimeout(() => proc.emit('close', 1), 0)
  return proc
}

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/phala-deploy-xyz'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('../queue/qstashClient.js', () => ({
  isQStashEnabled: vi.fn(() => false),
  publishJob: vi.fn(),
}))

vi.mock('../queue/webhookHandler.js', () => ({
  handlePhalaStep: vi.fn(() => Promise.resolve()),
}))

vi.mock('../billing/billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({
    getOrgBilling: vi.fn(),
    getOrgMarkup: vi.fn(),
  })),
}))

describe('PhalaOrchestrator', () => {
  let mockPrisma: any
  let orchestrator: PhalaOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PHALA_API_KEY = 'phak_test_key'

    mockPrisma = {
      service: {
        findUnique: vi.fn(),
      },
      phalaDeployment: {
        create: vi.fn(),
        update: vi.fn(),
      },
    }

    orchestrator = new PhalaOrchestrator(mockPrisma as unknown as PrismaClient)
  })

  describe('deployServicePhala', () => {
    it('throws when service not found', async () => {
      vi.mocked(mockPrisma.service.findUnique).mockResolvedValue(null)

      await expect(
        orchestrator.deployServicePhala('svc-999', {
          composeContent: 'services:\n  app:\n    image: nginx',
        })
      ).rejects.toThrow('Service not found')
    })

    it('creates record even when PHALA_API_KEY is not set (step handler checks later)', async () => {
      const orig = process.env.PHALA_API_KEY
      delete process.env.PHALA_API_KEY
      delete process.env.PHALA_CLOUD_API_KEY

      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
        project: { organizationId: null },
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })

      const id = await orchestrator.deployServicePhala('svc-1', {
        composeContent: 'services:\n  app:\n    image: nginx',
      })

      expect(id).toBe('dep-1')
      expect(mockPrisma.phalaDeployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appId: 'pending',
          status: 'CREATING',
          serviceId: 'svc-1',
        }),
      })

      process.env.PHALA_API_KEY = orig
    })

    it('creates DB record and returns deployment ID immediately (QStash handles steps)', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
        project: { organizationId: null },
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })

      const id = await orchestrator.deployServicePhala('svc-1', {
        composeContent: 'services:\n  app:\n    image: nginx',
      })

      expect(id).toBe('dep-1')
      expect(mockPrisma.phalaDeployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appId: 'pending',
          status: 'CREATING',
          serviceId: 'svc-1',
        }),
      })
    })

    it('returns deployment ID even if step will later fail (async pipeline)', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
        project: { organizationId: null },
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })

      const id = await orchestrator.deployServicePhala('svc-1', {
        composeContent: 'services:\n  app:\n    image: nginx',
      })

      expect(id).toBe('dep-1')
    })
  })

  describe('getCvmStatus', () => {
    it('returns parsed JSON from phala cvms get', async () => {
      vi.mocked(spawn).mockReturnValue(
        createMockSpawn(JSON.stringify({ status: 'running', app_id: 'app-1' })) as any
      )

      const status = await orchestrator.getCvmStatus('app-1')
      expect(status).toEqual({ status: 'running', app_id: 'app-1' })
    })

    it('returns null on error', async () => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      setTimeout(() => proc.emit('close', 1), 0)
      vi.mocked(spawn).mockReturnValue(proc as any)

      const status = await orchestrator.getCvmStatus('app-1')
      expect(status).toBeNull()
    })
  })

  describe('stopPhalaDeployment', () => {
    it('calls phala cvms stop', async () => {
      vi.mocked(spawn).mockReturnValue(createMockSpawn('') as any)

      await orchestrator.stopPhalaDeployment('app-1')

      expect(spawn).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['phala', 'cvms', 'stop', 'app-1']),
        expect.any(Object)
      )
    })
  })

  describe('deletePhalaDeployment', () => {
    it('calls phala cvms delete --force', async () => {
      vi.mocked(spawn).mockReturnValue(createMockSpawn('') as any)

      await orchestrator.deletePhalaDeployment('app-1')

      expect(spawn).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['phala', 'cvms', 'delete', 'app-1', '--force']),
        expect.any(Object)
      )
    })
  })

  describe('getPhalaLogs', () => {
    it('returns logs output', async () => {
      vi.mocked(spawn).mockReturnValue(createMockSpawn('log line 1\nlog line 2') as any)

      const logs = await orchestrator.getPhalaLogs('app-1')
      expect(logs).toBe('log line 1\nlog line 2')
    })

    it('returns null on error', async () => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      setTimeout(() => proc.emit('close', 1), 0)
      vi.mocked(spawn).mockReturnValue(proc as any)

      const logs = await orchestrator.getPhalaLogs('app-1')
      expect(logs).toBeNull()
    })
  })

  describe('getPhalaAttestation', () => {
    it('returns attestation JSON', async () => {
      const attestation = { verified: true, quote: 'abc' }
      vi.mocked(spawn).mockReturnValue(createMockSpawn(JSON.stringify(attestation)) as any)

      const result = await orchestrator.getPhalaAttestation('app-1')
      expect(result).toEqual(attestation)
    })

    it('returns null on error', async () => {
      vi.mocked(spawn).mockReturnValue(createFailingSpawn() as any)

      const result = await orchestrator.getPhalaAttestation('app-1')
      expect(result).toBeNull()
    })
  })
})
