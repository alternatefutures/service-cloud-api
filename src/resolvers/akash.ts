/**
 * GraphQL resolvers for Akash deployments
 * 
 * Akash is a deployment target for all service types in the Service Registry.
 * This follows the Alternate Futures ecosystem architecture.
 */

import { GraphQLError } from 'graphql'
import { getAkashOrchestrator } from '../services/akash/orchestrator.js'
import type { Context } from './types.js'

// Helper to format AkashDeployment for GraphQL (BigInt → String conversion)
function formatDeployment(deployment: any) {
  return {
    ...deployment,
    dseq: deployment.dseq.toString(),
    depositUakt: deployment.depositUakt?.toString(),
  }
}

export const akashQueries = {
  akashDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    const deployment = await context.prisma.akashDeployment.findUnique({
      where: { id },
    })

    if (!deployment) {
      throw new GraphQLError('Akash deployment not found')
    }

    return formatDeployment(deployment)
  },

  akashDeployments: async (
    _: unknown,
    { serviceId, functionId, siteId }: { serviceId?: string; functionId?: string; siteId?: string },
    context: Context
  ) => {
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
    // Get the most recent active deployment for this service
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
    // Get the most recent active deployment for this function
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
    { input }: { input: { serviceId: string; depositUakt?: number; sdlContent?: string; sourceCode?: string } },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

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

    // Verify user has access to this project
    if (context.projectId && service.projectId !== context.projectId) {
      throw new GraphQLError('Not authorized to deploy this service')
    }

    // If source code is provided and this is a function, save it first
    if (input.sourceCode !== undefined && service.type === 'FUNCTION' && service.afFunction) {
      await context.prisma.aFFunction.update({
        where: { id: service.afFunction.id },
        data: { sourceCode: input.sourceCode },
      })
      console.log('[deployToAkash] Updated function source code for:', service.afFunction.id)
    }

    try {
      const orchestrator = getAkashOrchestrator(context.prisma)

      const deploymentId = await orchestrator.deployService(input.serviceId, {
        deposit: input.depositUakt,
        sdlContent: input.sdlContent,
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

    if (!func.sourceCode) {
      throw new GraphQLError('Function has no source code to deploy')
    }

    if (!func.serviceId) {
      throw new GraphQLError('Function has no associated service in the registry')
    }

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
        service: true,
        afFunction: true,
      },
    })

    if (!deployment) {
      throw new GraphQLError('Deployment not found')
    }

    if (deployment.status === 'CLOSED') {
      throw new GraphQLError('Deployment is already closed')
    }

    // Try to close on-chain, but force-close the DB record even if it fails
    // (the dseq may not exist on-chain, may already be closed, or may be corrupt)
    try {
      const orchestrator = getAkashOrchestrator(context.prisma)
      await orchestrator.closeDeployment(Number(deployment.dseq))
    } catch (error) {
      console.warn(
        `[closeAkashDeployment] On-chain close failed for dseq=${deployment.dseq}: ${error instanceof Error ? error.message : 'Unknown error'}. Force-closing DB record.`
      )
      // Continue — we still mark as CLOSED in the DB below
    }

    const updated = await context.prisma.akashDeployment.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
      },
    })

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

    return formatDeployment(updated)
  },
}

export const akashFieldResolvers = {
  AkashDeployment: {
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
  },

  // Add akashDeployments resolver to Service type
  Service: {
    akashDeployments: async (parent: any, _: unknown, context: Context) => {
      const deployments = await context.prisma.akashDeployment.findMany({
        where: { serviceId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
      return deployments.map(formatDeployment)
    },
    activeAkashDeployment: async (parent: any, _: unknown, context: Context) => {
      const deployment = await context.prisma.akashDeployment.findFirst({
        where: {
          serviceId: parent.id,
          status: 'ACTIVE',
        },
        orderBy: { createdAt: 'desc' },
      })
      return deployment ? formatDeployment(deployment) : null
    },
  },
}
