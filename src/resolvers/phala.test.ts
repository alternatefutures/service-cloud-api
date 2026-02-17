import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from './types.js'

const mockStopPhalaDeployment = vi.fn()
const mockDeletePhalaDeployment = vi.fn()

vi.mock('../services/phala/orchestrator.js', () => ({
  getPhalaOrchestrator: () => ({
    stopPhalaDeployment: mockStopPhalaDeployment,
    deletePhalaDeployment: mockDeletePhalaDeployment,
  }),
}))

describe('Phala Resolvers', () => {
  let mockContext: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockStopPhalaDeployment.mockResolvedValue(undefined)
    mockDeletePhalaDeployment.mockResolvedValue(undefined)
    mockContext = {
      prisma: {
        phalaDeployment: {
          findUnique: vi.fn(),
          findFirst: vi.fn(),
          findMany: vi.fn(),
          update: vi.fn(),
        },
        service: {
          findUnique: vi.fn(),
        },
        site: {
          findUnique: vi.fn(),
        },
        aFFunction: {
          findUnique: vi.fn(),
        },
      } as any,
      userId: 'user-123',
    } as any
  })

  describe('phalaQueries', () => {
    describe('phalaDeployment', () => {
      it('returns deployment by id', async () => {
        const { phalaQueries: q } = await import('./phala.js')
        const mockDeployment = {
          id: 'dep-1',
          appId: 'app-123',
          name: 'af-test',
          status: 'ACTIVE',
          serviceId: 'svc-1',
        }
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          mockDeployment as any
        )

        const result = await q.phalaDeployment(
          null,
          { id: 'dep-1' },
          mockContext
        )

        expect(result).toEqual(mockDeployment)
        expect(mockContext.prisma.phalaDeployment.findUnique).toHaveBeenCalledWith(
          { where: { id: 'dep-1' }, include: expect.any(Object) }
        )
      })

      it('returns null when not found', async () => {
        const { phalaQueries: q } = await import('./phala.js')
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          null
        )

        const result = await q.phalaDeployment(
          null,
          { id: 'dep-999' },
          mockContext
        )

        expect(result).toBeNull()
      })
    })

    describe('phalaDeployments', () => {
      it('filters by serviceId', async () => {
        const { phalaQueries: q } = await import('./phala.js')
        vi.mocked(mockContext.prisma.phalaDeployment.findMany).mockResolvedValue(
          []
        )

        await q.phalaDeployments(
          null,
          { serviceId: 'svc-1' },
          mockContext
        )

        expect(mockContext.prisma.phalaDeployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { serviceId: 'svc-1' },
          })
        )
      })

      it('filters by projectId', async () => {
        const { phalaQueries: q } = await import('./phala.js')
        vi.mocked(mockContext.prisma.phalaDeployment.findMany).mockResolvedValue(
          []
        )

        await q.phalaDeployments(
          null,
          { projectId: 'proj-1' },
          mockContext
        )

        expect(mockContext.prisma.phalaDeployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { service: { projectId: 'proj-1' } },
          })
        )
      })
    })

    describe('phalaDeploymentByService', () => {
      it('returns deployment for service', async () => {
        const { phalaQueries: q } = await import('./phala.js')
        const mockDeployment = {
          id: 'dep-1',
          appId: 'app-123',
          serviceId: 'svc-1',
          status: 'ACTIVE',
        }
        vi.mocked(mockContext.prisma.phalaDeployment.findFirst).mockResolvedValue(
          mockDeployment as any
        )

        const result = await q.phalaDeploymentByService(
          null,
          { serviceId: 'svc-1' },
          mockContext
        )

        expect(result).toEqual(mockDeployment)
        expect(mockContext.prisma.phalaDeployment.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              serviceId: 'svc-1',
              status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
            },
          })
        )
      })
    })
  })

  describe('phalaMutations', () => {
    describe('stopPhalaDeployment', () => {
      it('throws when not authenticated', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        mockContext.userId = undefined

        await expect(
          mut.stopPhalaDeployment(null, { id: 'dep-1' }, mockContext)
        ).rejects.toThrow('Not authenticated')
      })

      it('throws when deployment not found', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          null
        )

        await expect(
          mut.stopPhalaDeployment(null, { id: 'dep-999' }, mockContext)
        ).rejects.toThrow('Phala deployment not found')
      })

      it('calls orchestrator and updates status', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        const mockDeployment = {
          id: 'dep-1',
          appId: 'app-123',
          status: 'ACTIVE',
        }
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          mockDeployment as any
        )
        vi.mocked(mockContext.prisma.phalaDeployment.update).mockResolvedValue({
          ...mockDeployment,
          status: 'STOPPED',
        } as any)

        const result = await mut.stopPhalaDeployment(
          null,
          { id: 'dep-1' },
          mockContext
        )

        expect(result.status).toBe('STOPPED')
        expect(mockStopPhalaDeployment).toHaveBeenCalledWith('app-123')
      })
    })

    describe('deletePhalaDeployment', () => {
      it('throws when not authenticated', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        mockContext.userId = undefined

        await expect(
          mut.deletePhalaDeployment(null, { id: 'dep-1' }, mockContext)
        ).rejects.toThrow('Not authenticated')
      })

      it('throws when deployment not found', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          null
        )

        await expect(
          mut.deletePhalaDeployment(null, { id: 'dep-999' }, mockContext)
        ).rejects.toThrow('Phala deployment not found')
      })

      it('calls orchestrator and updates status', async () => {
        const { phalaMutations: mut } = await import('./phala.js')
        const mockDeployment = {
          id: 'dep-1',
          appId: 'app-123',
          status: 'ACTIVE',
        }
        vi.mocked(mockContext.prisma.phalaDeployment.findUnique).mockResolvedValue(
          mockDeployment as any
        )
        vi.mocked(mockContext.prisma.phalaDeployment.update).mockResolvedValue({
          ...mockDeployment,
          status: 'DELETED',
        } as any)

        const result = await mut.deletePhalaDeployment(
          null,
          { id: 'dep-1' },
          mockContext
        )

        expect(result.status).toBe('DELETED')
        expect(mockDeletePhalaDeployment).toHaveBeenCalledWith('app-123')
      })
    })
  })
})
