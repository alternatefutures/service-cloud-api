import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  replaceCompositeServiceConfig,
  upsertCompositeServiceRecord,
} from './templates.js'

describe('composite template service helpers', () => {
  const baseData = {
    name: 'hyperscape-rhbt',
    slug: 'hyperscape-rhbt',
    type: 'VM' as const,
    projectId: 'project-123',
    templateId: 'hyperscape',
    createdByUserId: 'user-123',
    internalHostname: 'hyperscape-rhbt.project-123.internal',
    sdlServiceName: 'app',
    parentServiceId: null,
  }

  const prisma = {
    service: {
      create: vi.fn(),
      update: vi.fn(),
    },
    serviceEnvVar: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    servicePort: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    ),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    prisma.service.create.mockResolvedValue({ id: 'svc-new' })
    prisma.service.update.mockResolvedValue({ id: 'svc-existing' })
    prisma.serviceEnvVar.create.mockResolvedValue({ id: 'env-1' })
    prisma.servicePort.create.mockResolvedValue({ id: 'port-1' })
    prisma.serviceEnvVar.deleteMany.mockResolvedValue({ count: 2 })
    prisma.servicePort.deleteMany.mockResolvedValue({ count: 1 })
  })

  it('updates an existing composite service instead of creating a duplicate', async () => {
    await upsertCompositeServiceRecord(
      prisma as never,
      'svc-existing',
      baseData
    )

    expect(prisma.service.update).toHaveBeenCalledWith({
      where: { id: 'svc-existing' },
      data: baseData,
    })
    expect(prisma.service.create).not.toHaveBeenCalled()
  })

  it('replaces env vars and ports when reusing a composite service', async () => {
    await replaceCompositeServiceConfig(
      prisma as never,
      'svc-existing',
      [
        ['PUBLIC_PRIVY_APP_ID', 'abc123'],
        ['PRIVY_APP_SECRET', 'shhh'],
      ],
      [{ port: 5555, as: 80, global: true }]
    )

    expect(prisma.serviceEnvVar.deleteMany).toHaveBeenCalledWith({
      where: { serviceId: 'svc-existing' },
    })
    expect(prisma.servicePort.deleteMany).toHaveBeenCalledWith({
      where: { serviceId: 'svc-existing' },
    })
    expect(prisma.serviceEnvVar.create).toHaveBeenCalledTimes(2)
    expect(prisma.servicePort.create).toHaveBeenCalledTimes(1)
  })
})
