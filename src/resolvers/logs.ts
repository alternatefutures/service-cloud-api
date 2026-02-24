/**
 * Service Logs Resolver
 *
 * Exposes container logs from the active deployment (Akash or Phala)
 * through a unified `serviceLogs` query. The resolver determines which
 * provider owns the active deployment and delegates to its getLogs().
 */

import { GraphQLError } from 'graphql'
import type { Context } from './types.js'

export interface ServiceLogsArgs {
  serviceId: string
  tail?: number
  service?: string
}

export const logsQueries = {
  serviceLogs: async (
    _: unknown,
    { serviceId, tail, service }: ServiceLogsArgs,
    context: Context,
  ) => {
    const svc = await context.prisma.service.findUnique({
      where: { id: serviceId },
    })
    if (!svc) {
      throw new GraphQLError(`Service not found: ${serviceId}`)
    }

    const tailLines = tail ?? 200

    // Try Akash first — look for the most recent ACTIVE deployment
    const akashDeployment = await context.prisma.akashDeployment.findFirst({
      where: { serviceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    })

    if (akashDeployment && akashDeployment.provider) {
      const { getProvider } = await import('../services/providers/registry.js')
      const akash = getProvider('akash')
      try {
        const logs = await akash.getLogs(akashDeployment.id, {
          tail: tailLines,
          service,
        })
        return {
          logs,
          provider: 'akash',
          deploymentId: akashDeployment.id,
          timestamp: new Date(),
        }
      } catch (err) {
        throw new GraphQLError(
          `Failed to fetch Akash logs: ${(err as Error).message}`,
        )
      }
    }

    // Try Phala — look for the most recent ACTIVE deployment
    const phalaDeployment = await context.prisma.phalaDeployment.findFirst({
      where: { serviceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    })

    if (phalaDeployment) {
      const { getProvider } = await import('../services/providers/registry.js')
      const phala = getProvider('phala')
      try {
        const logs = await phala.getLogs(phalaDeployment.id, {
          tail: tailLines,
          service,
        })
        return {
          logs,
          provider: 'phala',
          deploymentId: phalaDeployment.id,
          timestamp: new Date(),
        }
      } catch (err) {
        throw new GraphQLError(
          `Failed to fetch Phala logs: ${(err as Error).message}`,
        )
      }
    }

    throw new GraphQLError(
      `No active deployment found for service ${serviceId}. Deploy first to view logs.`,
    )
  },
}
