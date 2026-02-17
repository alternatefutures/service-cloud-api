import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { PhalaOrchestrator } from './orchestrator.js'
import type { PrismaClient } from '@prisma/client'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/phala-deploy-xyz'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
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

    it('throws when PHALA_API_KEY is not set', async () => {
      const orig = process.env.PHALA_API_KEY
      delete process.env.PHALA_API_KEY
      delete process.env.PHALA_CLOUD_API_KEY

      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })

      await expect(
        orchestrator.deployServicePhala('svc-1', {
          composeContent: 'services:\n  app:\n    image: nginx',
        })
      ).rejects.toThrow('PHALA_API_KEY')

      process.env.PHALA_API_KEY = orig
    })

    it('creates DB record and updates on deploy success', async () => {
      vi.useFakeTimers()

      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })
      mockPrisma.phalaDeployment.update.mockResolvedValue({})

      vi.mocked(execSync)
        .mockReturnValueOnce(JSON.stringify({ success: true, app_id: 'app-123' }))
        .mockReturnValueOnce(
          JSON.stringify({
            status: 'running',
            public_urls: [{ app: 'https://app-123.phala.network' }],
          })
        )

      const deployPromise = orchestrator.deployServicePhala('svc-1', {
        composeContent: 'services:\n  app:\n    image: nginx',
      })
      await vi.advanceTimersByTimeAsync(6000)
      const id = await deployPromise

      vi.useRealTimers()

      expect(id).toBe('dep-1')
      expect(mockPrisma.phalaDeployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appId: 'pending',
          status: 'CREATING',
          serviceId: 'svc-1',
        }),
      })
      expect(mockPrisma.phalaDeployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'ACTIVE', appUrl: 'https://app-123.phala.network' },
        })
      )
    })

    it('sets FAILED and persists error on deploy failure', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        slug: 'test',
        type: 'VM',
        site: null,
        afFunction: null,
      })
      mockPrisma.phalaDeployment.create.mockResolvedValue({
        id: 'dep-1',
        appId: 'pending',
        name: 'af-test-xyz',
      })
      mockPrisma.phalaDeployment.update.mockResolvedValue({})

      vi.mocked(execSync).mockReturnValueOnce(
        JSON.stringify({ success: false, error: 'Quota exceeded' })
      )

      await expect(
        orchestrator.deployServicePhala('svc-1', {
          composeContent: 'services:\n  app:\n    image: nginx',
        })
      ).rejects.toThrow()

      expect(mockPrisma.phalaDeployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorMessage: expect.any(String),
          }),
        })
      )
    })
  })

  describe('getCvmStatus', () => {
    it('returns parsed JSON from phala cvms get', async () => {
      vi.mocked(execSync).mockReturnValue(
        JSON.stringify({ status: 'running', app_id: 'app-1' })
      )

      const status = await orchestrator.getCvmStatus('app-1')
      expect(status).toEqual({ status: 'running', app_id: 'app-1' })
    })

    it('returns null on error', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('CLI error')
      })

      const status = await orchestrator.getCvmStatus('app-1')
      expect(status).toBeNull()
    })
  })

  describe('stopPhalaDeployment', () => {
    it('calls phala cvms stop', async () => {
      vi.mocked(execSync).mockReturnValue('')

      await orchestrator.stopPhalaDeployment('app-1')

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('cvms stop app-1'),
        expect.any(Object)
      )
    })
  })

  describe('deletePhalaDeployment', () => {
    it('calls phala cvms delete --force', async () => {
      vi.mocked(execSync).mockReturnValue('')

      await orchestrator.deletePhalaDeployment('app-1')

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('cvms delete app-1'),
        expect.any(Object)
      )
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('--force'),
        expect.any(Object)
      )
    })
  })

  describe('getPhalaLogs', () => {
    it('returns logs output', async () => {
      vi.mocked(execSync).mockReturnValue('log line 1\nlog line 2')

      const logs = await orchestrator.getPhalaLogs('app-1')
      expect(logs).toBe('log line 1\nlog line 2')
    })

    it('returns null on error', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('CLI error')
      })

      const logs = await orchestrator.getPhalaLogs('app-1')
      expect(logs).toBeNull()
    })
  })

  describe('getPhalaAttestation', () => {
    it('returns attestation JSON', async () => {
      const attestation = { verified: true, quote: 'abc' }
      vi.mocked(execSync).mockReturnValue(JSON.stringify(attestation))

      const result = await orchestrator.getPhalaAttestation('app-1')
      expect(result).toEqual(attestation)
    })

    it('returns null on error', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('CLI error')
      })

      const result = await orchestrator.getPhalaAttestation('app-1')
      expect(result).toBeNull()
    })
  })
})
