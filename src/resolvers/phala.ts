/**
 * Phala Deployment Resolvers
 */
import { GraphQLError } from 'graphql'
import { getPhalaOrchestrator } from '../services/phala/index.js'
import { processFinalPhalaBilling } from '../services/billing/deploymentSettlement.js'
import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('resolver-phala')

type PhalaResourceSnapshot = {
  cpuUnits: number | null
  memoryBytes: number | null
  storageBytes: number | null
  gpuUnits: number | null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function findResourceInfo(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 5) return null

  const record = value as Record<string, unknown>
  const hasResourceShape =
    'vcpu' in record ||
    'memory_in_gb' in record ||
    'memoryInGb' in record ||
    'disk_in_gb' in record ||
    'diskInGb' in record ||
    'gpus' in record

  if (hasResourceShape) return record

  for (const nested of Object.values(record)) {
    const found = findResourceInfo(nested, depth + 1)
    if (found) return found
  }

  return null
}

async function getPhalaResourceSnapshot(parent: any, context: Context): Promise<PhalaResourceSnapshot> {
  const cached = parent.__resourceSnapshot as PhalaResourceSnapshot | undefined
  if (cached) return cached

  let snapshot: PhalaResourceSnapshot = {
    cpuUnits: null,
    memoryBytes: null,
    storageBytes: null,
    gpuUnits: null,
  }

  // During provisioning we intentionally avoid live CLI lookups so
  // project-wide service queries do not stall while the CVM is still coming up.
  if (parent.status !== 'ACTIVE' || !parent.appId || parent.appId === 'pending') {
    parent.__resourceSnapshot = snapshot
    return snapshot
  }

  try {
    const orchestrator = getPhalaOrchestrator(context.prisma)
    const status = await orchestrator.getCvmStatus(parent.appId)
    const resourceInfo = findResourceInfo(status)

    if (resourceInfo) {
      const vcpu = readNumber(resourceInfo.vcpu)
      const memoryInGb = readNumber(resourceInfo.memory_in_gb ?? resourceInfo.memoryInGb)
      const diskInGb = readNumber(resourceInfo.disk_in_gb ?? resourceInfo.diskInGb)
      const gpus = readNumber(resourceInfo.gpus)

      snapshot = {
        cpuUnits: vcpu,
        memoryBytes: memoryInGb != null ? memoryInGb * 1_000_000_000 : null,
        storageBytes: diskInGb != null ? diskInGb * 1_000_000_000 : null,
        gpuUnits: gpus != null ? Math.round(gpus) : null,
      }
    }
  } catch (error) {
    log.warn(error, `Failed to resolve live resource snapshot for Phala deployment ${parent.id}`)
  }

  parent.__resourceSnapshot = snapshot
  return snapshot
}

export const phalaQueries = {
  phalaDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    requireAuth(context)

    const deployment = await context.prisma.phalaDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } }, site: true, afFunction: true },
    })
    if (!deployment) throw new GraphQLError('Phala deployment not found')
    assertProjectAccess(context, deployment.service.project)
    return deployment
  },

  phalaDeployments: async (
    _: unknown,
    { serviceId, projectId }: { serviceId?: string; projectId?: string },
    context: Context
  ) => {
    requireAuth(context)

    if (serviceId) {
      const service = await context.prisma.service.findUnique({
        where: { id: serviceId },
        include: { project: true },
      })
      if (!service?.project) throw new GraphQLError('Service or project not found')
      assertProjectAccess(context, service.project)
    }
    if (projectId) {
      const project = await context.prisma.project.findUnique({ where: { id: projectId } })
      if (!project) throw new GraphQLError('Project not found')
      assertProjectAccess(context, project)
    }

    const where: Record<string, unknown> = {}
    if (serviceId) where.serviceId = serviceId
    if (projectId) where.service = { projectId } as any

    return context.prisma.phalaDeployment.findMany({
      where,
      include: { service: true },
      orderBy: { createdAt: 'desc' },
    })
  },

  phalaDeploymentByService: async (
    _: unknown,
    { serviceId }: { serviceId: string },
    context: Context
  ) => {
    requireAuth(context)

    const service = await context.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: true },
    })
    if (!service?.project) throw new GraphQLError('Service or project not found')
    assertProjectAccess(context, service.project)

    return context.prisma.phalaDeployment.findFirst({
      where: { serviceId, status: { in: ['CREATING', 'STARTING', 'ACTIVE'] } },
      include: { service: true },
      orderBy: { createdAt: 'desc' },
    })
  },
}

export const phalaFieldResolvers = {
  PhalaDeployment: {
    costPerHour: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return parent.hourlyRateCents / 100
    },
    costPerDay: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return (parent.hourlyRateCents / 100) * 24
    },
    costPerMonth: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return (parent.hourlyRateCents / 100) * 24 * 30
    },
    cpuUnits: async (parent: any, _: unknown, context: Context) => {
      const snapshot = await getPhalaResourceSnapshot(parent, context)
      return snapshot.cpuUnits
    },
    memoryBytes: async (parent: any, _: unknown, context: Context) => {
      const snapshot = await getPhalaResourceSnapshot(parent, context)
      return snapshot.memoryBytes
    },
    storageBytes: async (parent: any, _: unknown, context: Context) => {
      const snapshot = await getPhalaResourceSnapshot(parent, context)
      return snapshot.storageBytes
    },
    gpuUnits: async (parent: any, _: unknown, context: Context) => {
      const snapshot = await getPhalaResourceSnapshot(parent, context)
      return snapshot.gpuUnits
    },
    service: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.service.findUnique({
        where: { id: parent.serviceId },
      })
    },
    site: async (parent: any, _: unknown, context: Context) => {
      if (!parent.siteId) return null
      return context.prisma.site.findUnique({
        where: { id: parent.siteId },
      })
    },
    afFunction: async (parent: any, _: unknown, context: Context) => {
      if (!parent.afFunctionId) return null
      return context.prisma.aFFunction.findUnique({
        where: { id: parent.afFunctionId },
      })
    },
    policy: async (parent: any, _: unknown, context: Context) => {
      if (parent.policy) return parent.policy
      if (!parent.policyId) return null
      return context.prisma.deploymentPolicy.findUnique({
        where: { id: parent.policyId },
      })
    },
  },
  Service: {
    phalaDeployments: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      return context.prisma.phalaDeployment.findMany({
        where: { serviceId },
        orderBy: { createdAt: 'desc' },
      })
    },
    activePhalaDeployment: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      return context.prisma.phalaDeployment.findFirst({
        where: {
          serviceId,
          status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
  },
}

export const phalaMutations = {
  stopPhalaDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    requireAuth(context)

    const deployment = await context.prisma.phalaDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } } },
    })
    if (!deployment) throw new GraphQLError('Phala deployment not found')
    assertProjectAccess(context, deployment.service.project, 'Not authorized to stop this deployment')

    const stoppedAt = new Date()

    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(context.prisma, deployment.id, stoppedAt, 'phala_manual_stop')
    }

    // If the CVM hasn't been provisioned yet (appId still 'pending'),
    // skip the CLI call — there's nothing to stop on Phala's side.
    if (deployment.appId && deployment.appId !== 'pending') {
      const orchestrator = getPhalaOrchestrator(context.prisma)
      await orchestrator.stopPhalaDeployment(deployment.appId)
    }

    const updated = await context.prisma.phalaDeployment.update({
      where: { id },
      data: { status: 'STOPPED' },
      include: { service: true },
    })

    if (deployment.policyId) {
      await context.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt },
      })
    }

    // Cancel any in-progress sibling/retry deployments for the same service
    const IN_PROGRESS_PHALA = ['CREATING', 'STARTING'] as const
    const siblings = await context.prisma.phalaDeployment.findMany({
      where: {
        serviceId: deployment.serviceId,
        id: { not: id },
        status: { in: [...IN_PROGRESS_PHALA] },
      },
      select: { id: true, appId: true },
    })
    for (const sib of siblings) {
      if (sib.appId && sib.appId !== 'pending') {
        try {
          const orchestrator = getPhalaOrchestrator(context.prisma)
          await orchestrator.deletePhalaDeployment(sib.appId)
        } catch {
          // Non-fatal — CVM may not exist yet
        }
      }
      await context.prisma.phalaDeployment.update({
        where: { id: sib.id },
        data: { status: 'DELETED' },
      })
      log.info(`Closed sibling Phala deployment ${sib.id} (user cancelled ${id})`)
    }

    return updated
  },

  deletePhalaDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    requireAuth(context)

    const deployment = await context.prisma.phalaDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } } },
    })
    if (!deployment) throw new GraphQLError('Phala deployment not found')
    assertProjectAccess(context, deployment.service.project, 'Not authorized to delete this deployment')

    const deletedAt = new Date()

    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(
        context.prisma,
        deployment.id,
        deletedAt,
        'phala_manual_delete'
      )
    }

    if (deployment.appId && deployment.appId !== 'pending') {
      const orchestrator = getPhalaOrchestrator(context.prisma)
      await orchestrator.deletePhalaDeployment(deployment.appId)
    }

    const updated = await context.prisma.phalaDeployment.update({
      where: { id },
      data: { status: 'DELETED' },
      include: { service: true },
    })

    if (deployment.policyId) {
      await context.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: deletedAt },
      })
    }

    // Cancel any in-progress sibling/retry deployments for the same service
    const IN_PROGRESS_PHALA_DEL = ['CREATING', 'STARTING'] as const
    const siblings = await context.prisma.phalaDeployment.findMany({
      where: {
        serviceId: deployment.serviceId,
        id: { not: id },
        status: { in: [...IN_PROGRESS_PHALA_DEL] },
      },
      select: { id: true, appId: true },
    })
    for (const sib of siblings) {
      if (sib.appId && sib.appId !== 'pending') {
        try {
          const orchestrator = getPhalaOrchestrator(context.prisma)
          await orchestrator.deletePhalaDeployment(sib.appId)
        } catch {
          // Non-fatal — CVM may not exist yet
        }
      }
      await context.prisma.phalaDeployment.update({
        where: { id: sib.id },
        data: { status: 'DELETED' },
      })
      log.info(`Closed sibling Phala deployment ${sib.id} (user cancelled ${id})`)
    }

    return updated
  },
}
