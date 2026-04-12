/**
 * Phala Deployment Resolvers
 */
import { GraphQLError } from 'graphql'
import { getPhalaOrchestrator } from '../services/phala/index.js'
import { processFinalPhalaBilling } from '../services/billing/deploymentSettlement.js'
import { assertSubscriptionActive } from './subscriptionCheck.js'
import { assertDeployBalance } from './balanceCheck.js'
import { BILLING_CONFIG } from '../config/billing.js'
import { resolvePhalaInstanceType } from '../services/phala/instanceTypes.js'
import { validatePolicyInput } from '../services/policy/validator.js'
import type { DeploymentPolicyInput } from '../services/policy/types.js'
import {
  getTemplateById,
  generateComposeFromTemplate,
  getEnvKeysFromTemplate,
} from '../templates/index.js'
import type { TemplateResources, TemplateGpu } from '../templates/index.js'
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
  /**
   * Deploy an existing service to Phala Cloud (TEE).
   * For template-based services: generates compose from template.
   * Mirrors deployToAkash but routes through the Phala orchestrator.
   */
  deployToPhala: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        serviceId: string
        sourceCode?: string
        policy?: DeploymentPolicyInput
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
      }
    },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    await assertSubscriptionActive(context.organizationId)

    const service = await context.prisma.service.findUnique({
      where: { id: input.serviceId },
      include: {
        project: true,
        afFunction: true,
        site: true,
        envVars: true,
        ports: true,
      },
    })

    if (!service) {
      throw new GraphQLError('Service not found')
    }

    assertProjectAccess(context, service.project, 'Not authorized to deploy this service')

    if (input.sourceCode && service.type === 'FUNCTION' && service.afFunction) {
      await context.prisma.aFFunction.update({
        where: { id: service.afFunction.id },
        data: { sourceCode: input.sourceCode },
      })
    }

    const template = service.templateId ? getTemplateById(service.templateId) : null

    if (!template) {
      throw new GraphQLError(
        'Phala deployment currently requires a template-based service. ' +
        'Raw service deployment to Phala is not yet supported.'
      )
    }

    const envOverrides: Record<string, string> = {}
    for (const ev of service.envVars) {
      envOverrides[ev.key] = ev.value
    }

    const ro = input.resourceOverrides
    const templateResources: TemplateResources = {
      cpu: ro?.cpu ?? template.resources.cpu,
      memory: ro?.memory ?? template.resources.memory,
      storage: ro?.storage ?? template.resources.storage,
      gpu: ro?.gpu === null
        ? undefined
        : ro?.gpu
          ? { units: ro.gpu.units, vendor: ro.gpu.vendor as TemplateGpu['vendor'], model: ro.gpu.model }
          : template.resources.gpu,
    }

    log.info({ templateResources, hasOverrides: !!ro, gpuDisabled: ro?.gpu === null }, 'Resolved template resources for Phala deploy')

    let policyId: string | undefined
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
      const policyRecord = await context.prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: input.policy.acceptableGpuModels ?? [],
          gpuUnits: input.policy.gpuUnits ?? null,
          gpuVendor: input.policy.gpuVendor ?? null,
          maxBudgetUsd: input.policy.maxBudgetUsd ?? null,
          maxMonthlyUsd: input.policy.maxMonthlyUsd ?? null,
          runtimeMinutes: input.policy.runtimeMinutes ?? null,
          expiresAt: input.policy.runtimeMinutes
            ? new Date(Date.now() + input.policy.runtimeMinutes * 60_000)
            : null,
        },
      })
      policyId = policyRecord.id
    }

    const phalaInstance = await resolvePhalaInstanceType(
      templateResources,
      input.policy?.acceptableGpuModels,
      input.policy?.gpuUnits
    )

    const estimatedDailyCostCents = Math.max(
      BILLING_CONFIG.phala.minBalanceCentsToLaunch,
      Math.ceil(phalaInstance.hourlyRateUsd * 24 * 100)
    )
    await assertDeployBalance(context.organizationId, 'phala', context.prisma, {
      dailyCostCents: estimatedDailyCostCents,
    })

    const composeContent = generateComposeFromTemplate(template, {
      serviceName: service.slug,
      envOverrides,
    })

    const envKeys = getEnvKeysFromTemplate(template, envOverrides)

    const mergedEnv: Record<string, string> = {}
    for (const v of template.envVars) {
      if (v.default !== null) mergedEnv[v.key] = v.default
    }
    Object.assign(mergedEnv, envOverrides)

    const orchestrator = getPhalaOrchestrator(context.prisma)

    log.info(
      { serviceId: service.id, cvmSize: phalaInstance.cvmSize, gpuModel: phalaInstance.gpuModel, hourlyRate: phalaInstance.hourlyRateUsd },
      'Starting Phala deployment'
    )

    try {
      const deploymentId = await orchestrator.deployServicePhala(service.id, {
        composeContent,
        env: mergedEnv,
        envKeys,
        name: `af-${service.slug}-${Date.now().toString(36)}`,
        cvmSize: phalaInstance.cvmSize,
        gpuModel: phalaInstance.gpuModel ?? undefined,
        hourlyRateUsd: phalaInstance.hourlyRateUsd,
      })

      if (policyId) {
        await context.prisma.phalaDeployment.update({
          where: { id: deploymentId },
          data: { policyId },
        })
      }

      const deployment = await context.prisma.phalaDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
      })

      if (!deployment) {
        throw new GraphQLError('Phala deployment record not found after creation')
      }

      return deployment
    } catch (error: any) {
      const msg = error.message || 'Unknown error'
      if (msg.includes('No available resources')) {
        throw new GraphQLError(
          `No Confidential GPU capacity available for ${phalaInstance.cvmSize}. ` +
          `Try deploying to Standard compute instead, or try again later.`
        )
      }
      throw new GraphQLError(
        `Phala deployment failed: ${msg}`
      )
    }
  },

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
      try {
        const orchestrator = getPhalaOrchestrator(context.prisma)
        await orchestrator.stopPhalaDeployment(deployment.appId)
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        const alreadyGone = /not found|does not exist|already stopped|already deleted|no such|404/i.test(errMsg)
        if (alreadyGone) {
          log.warn({ appId: deployment.appId, err: error }, 'CVM already gone — proceeding to mark STOPPED in DB')
        } else {
          throw new GraphQLError(`Failed to stop CVM: ${errMsg}`)
        }
      }
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
      try {
        const orchestrator = getPhalaOrchestrator(context.prisma)
        await orchestrator.deletePhalaDeployment(deployment.appId)
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        const alreadyGone = /not found|does not exist|already stopped|already deleted|no such|404/i.test(errMsg)
        if (alreadyGone) {
          log.warn({ appId: deployment.appId, err: error }, 'CVM already gone — proceeding to mark DELETED in DB')
        } else {
          throw new GraphQLError(`Failed to delete CVM: ${errMsg}`)
        }
      }
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
