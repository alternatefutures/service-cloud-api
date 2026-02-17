/**
 * Phala Deployment Resolvers
 */
import { GraphQLError } from 'graphql'
import { getPhalaOrchestrator } from '../services/phala/index.js'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import type { Context } from './types.js'

/**
 * Process final billing for a Phala deployment.
 * Bills for partial hours since the last billing checkpoint.
 */
async function processFinalPhalaBilling(deployment: any) {
  if (!deployment.orgBillingId || !deployment.hourlyRateCents) return

  const now = new Date()
  const lastBilled = deployment.lastBilledAt || deployment.activeStartedAt || deployment.createdAt
  const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

  if (hoursSinceLastBill < 0.01) return // less than ~36 seconds, skip

  // Bill for partial hours (round up to nearest minute = 1/60 hour)
  const billableHours = Math.ceil(hoursSinceLastBill * 60) / 60
  const amountCents = Math.ceil(billableHours * deployment.hourlyRateCents)

  if (amountCents <= 0) return

  try {
    const billingApi = getBillingApiClient()
    await billingApi.computeDebit({
      orgBillingId: deployment.orgBillingId,
      amountCents,
      serviceType: 'phala_tee',
      provider: 'phala',
      resource: deployment.id,
      description: `Phala TEE final billing: ${billableHours.toFixed(2)}h @ $${(deployment.hourlyRateCents / 100).toFixed(2)}/hr`,
      idempotencyKey: `phala_final:${deployment.id}:${now.getTime()}`,
    })
    console.log(`[Phala] Final billing for ${deployment.id}: $${(amountCents / 100).toFixed(2)}`)
  } catch (error) {
    console.warn(`[Phala] Final billing failed for ${deployment.id}:`, error)
  }
}

export const phalaQueries = {
  phalaDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    return context.prisma.phalaDeployment.findUnique({
      where: { id },
      include: { service: true, site: true, afFunction: true },
    })
  },

  phalaDeployments: async (
    _: unknown,
    { serviceId, projectId }: { serviceId?: string; projectId?: string },
    context: Context
  ) => {
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
    return context.prisma.phalaDeployment.findFirst({
      where: { serviceId, status: { in: ['CREATING', 'STARTING', 'ACTIVE'] } },
      include: { service: true },
      orderBy: { createdAt: 'desc' },
    })
  },
}

export const phalaFieldResolvers = {
  PhalaDeployment: {
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
  },
  Service: {
    phalaDeployments: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.phalaDeployment.findMany({
        where: { serviceId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
    activePhalaDeployment: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.phalaDeployment.findFirst({
        where: {
          serviceId: parent.id,
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
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const deployment = await context.prisma.phalaDeployment.findUnique({
      where: { id },
    })
    if (!deployment) throw new GraphQLError('Phala deployment not found')

    // Final billing for partial period before stopping
    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(deployment)
    }

    const orchestrator = getPhalaOrchestrator(context.prisma)
    await orchestrator.stopPhalaDeployment(deployment.appId)

    return context.prisma.phalaDeployment.update({
      where: { id },
      data: { status: 'STOPPED' },
      include: { service: true },
    })
  },

  deletePhalaDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const deployment = await context.prisma.phalaDeployment.findUnique({
      where: { id },
    })
    if (!deployment) throw new GraphQLError('Phala deployment not found')

    // Final billing for partial period before deleting
    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(deployment)
    }

    const orchestrator = getPhalaOrchestrator(context.prisma)
    await orchestrator.deletePhalaDeployment(deployment.appId)

    return context.prisma.phalaDeployment.update({
      where: { id },
      data: { status: 'DELETED' },
      include: { service: true },
    })
  },
}
