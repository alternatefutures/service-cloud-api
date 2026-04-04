/**
 * GraphQL resolvers for Akash deployments
 * 
 * Akash is a deployment target for all service types in the Service Registry.
 * This follows the Alternate Futures ecosystem architecture.
 */

import { GraphQLError } from 'graphql'
import { getAkashOrchestrator } from '../services/akash/orchestrator.js'
import { getEscrowService } from '../services/billing/escrowService.js'
import { settleAkashEscrowToTime } from '../services/billing/deploymentSettlement.js'
import { assertSubscriptionActive } from './subscriptionCheck.js'
import { assertDeployBalance } from './balanceCheck.js'
import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { createLogger } from '../lib/logger.js'
import { validatePolicyInput } from '../services/policy/validator.js'
import type { DeploymentPolicyInput } from '../services/policy/types.js'
import { BILLING_CONFIG } from '../config/billing.js'

const log = createLogger('resolver-akash')

// Helper to format AkashDeployment for GraphQL (BigInt → String conversion)
function formatDeployment(deployment: any) {
  return {
    ...deployment,
    dseq: deployment.dseq.toString(),
    depositUakt: deployment.depositUakt?.toString(),
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractProfilesComputeSection(sdl: string): string {
  const match = sdl.match(/profiles:\s*\n\s{2}compute:\s*\n([\s\S]*?)(?=\n\s{2}(?:placement|deployment):|$)/)
  return match?.[1] ?? ''
}

function parseSizeToBytes(value: string): number | null {
  const match = value.trim().match(/^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T|B)?$/i)
  if (!match) return null

  const amount = parseFloat(match[1])
  if (!Number.isFinite(amount)) return null

  const unit = (match[2] || 'B').toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1,
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    KI: 1024,
    MI: 1024 ** 2,
    GI: 1024 ** 3,
    TI: 1024 ** 4,
  }

  return amount * (multipliers[unit] ?? 1)
}

function extractComputeProfileBlock(sdl: string, profileName?: string | null): string {
  const computeSection = extractProfilesComputeSection(sdl)
  if (!computeSection) return ''

  if (profileName) {
    const sectionRegex = new RegExp(
      `(?:^|\\n)\\s{4}${escapeRegex(profileName)}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{4}[A-Za-z0-9_-]+:\\s*\\n|$)`,
    )
    const match = computeSection.match(sectionRegex)
    if (match?.[1]) return match[1]
  }

  const firstProfileRegex =
    /(?:^|\n)\s{4}[A-Za-z0-9_-]+:\s*\n([\s\S]*?)(?=\n\s{4}[A-Za-z0-9_-]+:\s*\n|$)/
  return computeSection.match(firstProfileRegex)?.[1] ?? ''
}

async function parseAkashDeploymentResources(parent: any, context: Context) {
  if (!parent.sdlContent) {
    return { cpuUnits: null, memoryBytes: null, storageBytes: null, gpuUnits: null }
  }

  const service = await context.prisma.service.findUnique({
    where: { id: parent.serviceId },
    select: { sdlServiceName: true, slug: true },
  })

  const block = extractComputeProfileBlock(
    parent.sdlContent,
    service?.sdlServiceName ?? service?.slug ?? null,
  )
  if (!block) {
    return { cpuUnits: null, memoryBytes: null, storageBytes: null, gpuUnits: null }
  }

  const cpuMatch = block.match(/cpu:\s*\n\s*units:\s*([0-9.]+)/)
  const memoryMatch = block.match(/memory:\s*\n\s*size:\s*([0-9.]+\s*[A-Za-z]*)/)
  const gpuMatch = block.match(/gpu:\s*\n\s*units:\s*([0-9.]+)/)

  const storageSection = block.match(/storage:\s*\n([\s\S]*?)(?=\n\s{6}[A-Za-z][A-Za-z0-9_-]*:\s*\n|$)/)
  const storageMatches = storageSection?.[1].match(/size:\s*([0-9.]+\s*[A-Za-z]*)/g) ?? []
  const storageBytes = storageMatches.reduce((sum, entry) => {
    const sizeMatch = entry.match(/size:\s*([0-9.]+\s*[A-Za-z]*)/)
    const bytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : null
    return sum + (bytes ?? 0)
  }, 0)

  return {
    cpuUnits: cpuMatch ? parseFloat(cpuMatch[1]) : null,
    memoryBytes: memoryMatch ? parseSizeToBytes(memoryMatch[1]) : null,
    storageBytes: storageMatches.length > 0 ? storageBytes : null,
    gpuUnits: gpuMatch ? Math.round(parseFloat(gpuMatch[1])) : null,
  }
}

/**
 * Estimate daily USD cost (in cents) for a GPU deployment using provider registry pricing.
 * Falls back to a conservative $18/day if no registry data available.
 */
async function estimateGpuDailyCost(
  prisma: import('@prisma/client').PrismaClient,
  gpuUnits: number,
  gpuModels: string[]
): Promise<number> {
  try {
    const where: any = {
      verified: true,
      blocked: false,
      gpuAvailable: { gt: 0 },
      minPriceUact: { not: null },
    }
    if (gpuModels.length > 0) {
      where.gpuModels = { hasSome: gpuModels.map(m => m.toLowerCase()) }
    }

    const providers = await prisma.computeProvider.findMany({
      where,
      select: { minPriceUact: true },
    })

    if (providers.length === 0) return 1800 * gpuUnits

    const { getAktUsdPrice, akashPricePerBlockToUsdPerDay, applyMargin, DEFAULT_MONTHLY_MARGIN } =
      await import('../config/pricing.js')
    const aktPrice = await getAktUsdPrice()

    const minUact = providers.reduce(
      (min, p) => (p.minPriceUact! < min ? p.minPriceUact! : min),
      providers[0].minPriceUact!
    )
    const dailyUsd = akashPricePerBlockToUsdPerDay(Number(minUact), aktPrice)
    const withMargin = applyMargin(dailyUsd, DEFAULT_MONTHLY_MARGIN)
    return Math.ceil(withMargin * 100) * gpuUnits
  } catch (error) {
    log.warn(error, 'Failed to estimate GPU cost from registry — using $18/day fallback')
    return 1800 * gpuUnits
  }
}

async function assertServiceAccess(context: Context, serviceId: string) {
  const service = await context.prisma.service.findUnique({
    where: { id: serviceId },
    include: { project: true },
  })
  if (!service?.project) throw new GraphQLError('Service or project not found')
  assertProjectAccess(context, service.project)
}

export const akashQueries = {
  akashDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    requireAuth(context)

    const deployment = await context.prisma.akashDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } } },
    })

    if (!deployment) {
      throw new GraphQLError('Akash deployment not found')
    }

    assertProjectAccess(context, deployment.service.project)
    return formatDeployment(deployment)
  },

  akashDeployments: async (
    _: unknown,
    { serviceId, functionId, siteId }: { serviceId?: string; functionId?: string; siteId?: string },
    context: Context
  ) => {
    requireAuth(context)

    if (serviceId) await assertServiceAccess(context, serviceId)
    if (functionId) {
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: functionId },
        include: { project: true },
      })
      if (!func?.project) throw new GraphQLError('Function or project not found')
      assertProjectAccess(context, func.project)
    }
    if (siteId) {
      const site = await context.prisma.site.findUnique({
        where: { id: siteId },
        include: { project: true },
      })
      if (!site?.project) throw new GraphQLError('Site or project not found')
      assertProjectAccess(context, site.project)
    }

    const where: any = {}
    if (serviceId) where.serviceId = serviceId
    if (functionId) where.afFunctionId = functionId
    if (siteId) where.siteId = siteId

    const deployments = await context.prisma.akashDeployment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return deployments.map(formatDeployment)
  },

  akashDeploymentByService: async (
    _: unknown,
    { serviceId }: { serviceId: string },
    context: Context
  ) => {
    requireAuth(context)
    await assertServiceAccess(context, serviceId)

    const deployment = await context.prisma.akashDeployment.findFirst({
      where: {
        serviceId,
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!deployment) {
      return null
    }

    return formatDeployment(deployment)
  },

  akashDeploymentByFunction: async (
    _: unknown,
    { functionId }: { functionId: string },
    context: Context
  ) => {
    requireAuth(context)

    const func = await context.prisma.aFFunction.findUnique({
      where: { id: functionId },
      include: { project: true },
    })
    if (!func?.project) throw new GraphQLError('Function or project not found')
    assertProjectAccess(context, func.project)

    const deployment = await context.prisma.akashDeployment.findFirst({
      where: {
        afFunctionId: functionId,
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!deployment) {
      return null
    }

    return formatDeployment(deployment)
  },
}

export const akashMutations = {
  /**
   * Deploy any service to Akash (general-purpose mutation)
   */
  deployToAkash: async (
    _: unknown,
    { input }: { input: { serviceId: string; depositUakt?: number; sdlContent?: string; sourceCode?: string; policy?: DeploymentPolicyInput } },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    await assertSubscriptionActive(context.organizationId)

    // Get the service from the registry
    const service = await context.prisma.service.findUnique({
      where: { id: input.serviceId },
      include: {
        project: true,
        afFunction: true,
        site: true,
      },
    })

    if (!service) {
      throw new GraphQLError('Service not found')
    }

    assertProjectAccess(context, service.project, 'Not authorized to deploy this service')

    // If source code is provided and this is a function, save it first
    if (input.sourceCode !== undefined && service.type === 'FUNCTION' && service.afFunction) {
      await context.prisma.aFFunction.update({
        where: { id: service.afFunction.id },
        data: { sourceCode: input.sourceCode },
      })
      log.info(`Updated function source code for: ${service.afFunction.id}`)
    }

    // ── Validate and create deployment policy ────────────────
    let policyId: string | undefined
    let estimatedDailyCostCents: number = BILLING_CONFIG.akash.minBalanceCentsToLaunch
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }

      if (input.policy.gpuUnits && input.policy.gpuUnits > 0) {
        estimatedDailyCostCents = await estimateGpuDailyCost(
          context.prisma,
          input.policy.gpuUnits,
          input.policy.acceptableGpuModels ?? []
        )
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

    await assertDeployBalance(context.organizationId, 'akash', context.prisma, {
      dailyCostCents: estimatedDailyCostCents,
    })

    try {
      const orchestrator = getAkashOrchestrator(context.prisma)

      const deploymentId = await orchestrator.deployService(input.serviceId, {
        deposit: input.depositUakt,
        sdlContent: input.sdlContent,
      })

      if (policyId) {
        await context.prisma.akashDeployment.update({
          where: { id: deploymentId },
          data: { policyId },
        })
      }

      const deployment = await context.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
      })

      if (!deployment) {
        throw new GraphQLError('Deployment creation failed')
      }

      return formatDeployment(deployment)
    } catch (error) {
      throw new GraphQLError(
        `Akash deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  },

  /**
   * Deploy a function to Akash (convenience mutation, legacy compatibility)
   */
  deployFunctionToAkash: async (
    _: unknown,
    { input }: { input: { functionId: string; depositUakt?: number } },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    await assertSubscriptionActive(context.organizationId)

    // Get the function with its service
    const func = await context.prisma.aFFunction.findUnique({
      where: { id: input.functionId },
      include: { 
        project: true,
        service: true,
      },
    })

    if (!func) {
      throw new GraphQLError('Function not found')
    }

    assertProjectAccess(context, func.project, 'Not authorized to deploy this function')

    if (!func.sourceCode) {
      throw new GraphQLError('Function has no source code to deploy')
    }

    if (!func.serviceId) {
      throw new GraphQLError('Function has no associated service in the registry')
    }

    await assertDeployBalance(context.organizationId, 'akash', context.prisma, {
      dailyCostCents: BILLING_CONFIG.akash.minBalanceCentsToLaunch,
    })

    // Mark function as deploying
    await context.prisma.aFFunction.update({
      where: { id: input.functionId },
      data: { status: 'DEPLOYING' },
    })

    try {
      const orchestrator = getAkashOrchestrator(context.prisma)

      const deploymentId = await orchestrator.deployService(func.serviceId, {
        deposit: input.depositUakt || 5000000,
      })

      // Fetch the created deployment
      const deployment = await context.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
      })

      if (!deployment) {
        throw new GraphQLError('Deployment creation failed')
      }

      return formatDeployment(deployment)
    } catch (error) {
      // Reset function status on error
      await context.prisma.aFFunction.update({
        where: { id: input.functionId },
        data: { status: 'FAILED' },
      })

      throw new GraphQLError(
        `Akash deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  },

  closeAkashDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    const deployment = await context.prisma.akashDeployment.findUnique({
      where: { id },
      include: {
        service: { include: { project: true } },
        afFunction: true,
      },
    })

    if (!deployment) {
      throw new GraphQLError('Deployment not found')
    }

    assertProjectAccess(context, deployment.service.project, 'Not authorized to close this deployment')

    if (deployment.status === 'CLOSED') {
      throw new GraphQLError('Deployment is already closed')
    }

    if (deployment.status === 'SUSPENDED') {
      // On-chain deployment was already closed by the billing scheduler.
      // Just transition SUSPENDED → CLOSED in the DB without on-chain close.
      const updated = await context.prisma.akashDeployment.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date() },
      })
      if (deployment.policyId) {
        await context.prisma.deploymentPolicy.update({
          where: { id: deployment.policyId },
          data: { stopReason: 'MANUAL_STOP', stoppedAt: new Date() },
        })
      }
      return formatDeployment(updated)
    }

    const closedAt = new Date()

    try {
      const orchestrator = getAkashOrchestrator(context.prisma)
      await orchestrator.closeDeployment(Number(deployment.dseq))
    } catch (error) {
      log.error(
        { dseq: deployment.dseq?.toString(), err: error },
        'On-chain close failed — cannot mark CLOSED or refund escrow while deployment may still be running'
      )
      throw new GraphQLError(
        `Failed to close deployment on-chain (dseq=${deployment.dseq}). The deployment may still be running. Try again or contact support.`
      )
    }

    const updated = await context.prisma.akashDeployment.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt,
      },
    })

    try {
      await settleAkashEscrowToTime(context.prisma, id, closedAt)
      const escrowService = getEscrowService(context.prisma)
      const refundCents = await escrowService.refundEscrow(id)
      if (refundCents > 0) {
        log.info(`Refunded $${(refundCents / 100).toFixed(2)} escrow for deployment ${id}`)
      }
    } catch (error) {
      log.warn(error, `Escrow settlement/refund failed for ${id} — deployment is closed, refund may need manual resolution`)
    }

    // Update the specific resource status based on service type
    if (deployment.service.type === 'FUNCTION' && deployment.afFunctionId) {
      await context.prisma.aFFunction.update({
        where: { id: deployment.afFunctionId },
        data: {
          status: 'INACTIVE',
          invokeUrl: null,
        },
      })
    }

    if (deployment.policyId) {
      await context.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: closedAt },
      })
    }

    // Cancel any in-progress sibling/retry deployments for the same service
    const IN_PROGRESS = ['CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING'] as const
    const siblings = await context.prisma.akashDeployment.findMany({
      where: {
        serviceId: deployment.serviceId,
        id: { not: id },
        status: { in: [...IN_PROGRESS] },
      },
      select: { id: true, dseq: true },
    })
    for (const sib of siblings) {
      if (sib.dseq && Number(sib.dseq) > 0) {
        try {
          const orchestrator = getAkashOrchestrator(context.prisma)
          await orchestrator.closeDeployment(Number(sib.dseq))
        } catch {
          // Non-fatal
        }
      }
      await context.prisma.akashDeployment.update({
        where: { id: sib.id },
        data: { status: 'CLOSED', closedAt },
      })
      log.info(`Closed sibling deployment ${sib.id} (user cancelled ${id})`)
    }

    return formatDeployment(updated)
  },
}

export const akashFieldResolvers = {
  AkashDeployment: {
    image: async (parent: any, _: unknown, context: Context) => {
      if (!parent.sdlContent) return null

      // For multi-service SDLs, find the image for the owning service's SDL name
      const service = await context.prisma.service.findUnique({
        where: { id: parent.serviceId },
      })
      const sdlName = service?.sdlServiceName
      if (sdlName) {
        const sectionRegex = new RegExp(
          `(?:^|\\n)\\s*${sdlName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\S+:\\s*\\n|$)`,
        )
        const section = parent.sdlContent.match(sectionRegex)
        if (section) {
          const imgMatch = section[1].match(/image:\s*["']?([^\s"']+)/)
          if (imgMatch) return imgMatch[1]
        }
      }

      // Fallback: first image in the SDL
      const match = parent.sdlContent.match(/image:\s*["']?([^\s"']+)/)
      return match ? match[1] : null
    },
    costPerDay: async (parent: any) => {
      if (parent.pricePerBlock) {
        const { akashPricePerBlockToUsdPerDay, getAktUsdPrice, applyMargin, DEFAULT_MONTHLY_MARGIN } = await import('../config/pricing.js')
        const aktPrice = await getAktUsdPrice()
        const raw = akashPricePerBlockToUsdPerDay(parent.pricePerBlock, aktPrice)
        return applyMargin(raw, DEFAULT_MONTHLY_MARGIN)
      }
      if (parent.dailyRateCentsCharged != null) return parent.dailyRateCentsCharged / 100
      return null
    },
    costPerHour: async (parent: any) => {
      if (parent.pricePerBlock) {
        const { akashPricePerBlockToUsdPerDay, getAktUsdPrice, applyMargin, DEFAULT_MONTHLY_MARGIN } = await import('../config/pricing.js')
        const aktPrice = await getAktUsdPrice()
        const raw = akashPricePerBlockToUsdPerDay(parent.pricePerBlock, aktPrice)
        return applyMargin(raw, DEFAULT_MONTHLY_MARGIN) / 24
      }
      if (parent.dailyRateCentsCharged != null) return parent.dailyRateCentsCharged / 100 / 24
      return null
    },
    costPerMonth: async (parent: any) => {
      if (parent.pricePerBlock) {
        const { akashPricePerBlockToUsdPerDay, getAktUsdPrice, applyMargin, DEFAULT_MONTHLY_MARGIN } = await import('../config/pricing.js')
        const aktPrice = await getAktUsdPrice()
        const raw = akashPricePerBlockToUsdPerDay(parent.pricePerBlock, aktPrice)
        return applyMargin(raw, DEFAULT_MONTHLY_MARGIN) * 30
      }
      if (parent.dailyRateCentsCharged != null) return (parent.dailyRateCentsCharged / 100) * 30
      return null
    },
    cpuUnits: async (parent: any, _: unknown, context: Context) => {
      const resources = await parseAkashDeploymentResources(parent, context)
      return resources.cpuUnits
    },
    memoryBytes: async (parent: any, _: unknown, context: Context) => {
      const resources = await parseAkashDeploymentResources(parent, context)
      return resources.memoryBytes
    },
    storageBytes: async (parent: any, _: unknown, context: Context) => {
      const resources = await parseAkashDeploymentResources(parent, context)
      return resources.storageBytes
    },
    gpuUnits: async (parent: any, _: unknown, context: Context) => {
      const resources = await parseAkashDeploymentResources(parent, context)
      return resources.gpuUnits
    },
    service: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.service.findUnique({
        where: { id: parent.serviceId },
      })
    },
    afFunction: async (parent: any, _: unknown, context: Context) => {
      if (!parent.afFunctionId) return null
      return context.prisma.aFFunction.findUnique({
        where: { id: parent.afFunctionId },
      })
    },
    site: async (parent: any, _: unknown, context: Context) => {
      if (!parent.siteId) return null
      return context.prisma.site.findUnique({
        where: { id: parent.siteId },
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

  // Add akashDeployments resolver to Service type
  Service: {
    akashDeployments: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      const deployments = await context.prisma.akashDeployment.findMany({
        where: { serviceId },
        orderBy: { createdAt: 'desc' },
      })
      return deployments.map(formatDeployment)
    },
    activeAkashDeployment: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      const deployment = await context.prisma.akashDeployment.findFirst({
        where: {
          serviceId,
          status: { in: ['CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING', 'ACTIVE'] },
        },
        orderBy: { createdAt: 'desc' },
      })
      return deployment ? formatDeployment(deployment) : null
    },
  },
}
