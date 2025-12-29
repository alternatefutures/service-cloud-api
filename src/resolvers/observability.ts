/**
 * Observability GraphQL Resolvers
 *
 * Resolvers for traces, metrics, logs, and telemetry usage queries.
 * All queries are project-scoped for multi-tenant isolation.
 */

import { GraphQLError } from 'graphql'
import {
  getClickHouseClient,
  getTelemetryIngestionService,
  type TraceQueryInput,
  type MetricQueryInput,
  type LogQueryInput,
} from '../services/observability/index.js'
import type { Context } from './types.js'

/**
 * Verify user has access to a project
 */
async function verifyProjectAccess(
  projectId: string,
  context: Context
): Promise<void> {
  if (!context.userId) {
    throw new GraphQLError('Authentication required')
  }

  const project = await context.prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) {
    throw new GraphQLError('Project not found')
  }

  if (project.userId !== context.userId) {
    throw new GraphQLError(
      'Unauthorized - you do not have access to this project'
    )
  }
}

export const observabilityQueries = {
  /**
   * Query traces with filters
   */
  traces: async (
    _: unknown,
    { input }: { input: TraceQueryInput },
    context: Context
  ) => {
    await verifyProjectAccess(input.projectId, context)

    const client = getClickHouseClient()
    return client.queryTraces(input)
  },

  /**
   * Get a single trace by ID
   */
  trace: async (
    _: unknown,
    { projectId, traceId }: { projectId: string; traceId: string },
    context: Context
  ) => {
    await verifyProjectAccess(projectId, context)

    const client = getClickHouseClient()
    return client.getTrace(projectId, traceId)
  },

  /**
   * Query metrics with aggregation
   */
  metrics: async (
    _: unknown,
    { input }: { input: MetricQueryInput },
    context: Context
  ) => {
    await verifyProjectAccess(input.projectId, context)

    const client = getClickHouseClient()

    // Convert GraphQL enum to lowercase
    const aggregation = input.aggregation?.toLowerCase() as
      | 'avg'
      | 'sum'
      | 'min'
      | 'max'
      | 'count'
      | undefined

    return client.queryMetrics({
      ...input,
      aggregation,
    })
  },

  /**
   * Query logs
   */
  logs: async (
    _: unknown,
    { input }: { input: LogQueryInput },
    context: Context
  ) => {
    await verifyProjectAccess(input.projectId, context)

    const client = getClickHouseClient()
    return client.queryLogs(input)
  },

  /**
   * Get service statistics for a project
   */
  services: async (
    _: unknown,
    {
      projectId,
      startTime,
      endTime,
    }: { projectId: string; startTime: Date; endTime: Date },
    context: Context
  ) => {
    await verifyProjectAccess(projectId, context)

    const client = getClickHouseClient()
    return client.getServices(projectId, startTime, endTime)
  },

  /**
   * Get observability settings for a project
   */
  observabilitySettings: async (
    _: unknown,
    { projectId }: { projectId: string },
    context: Context
  ) => {
    await verifyProjectAccess(projectId, context)

    // Get or create settings
    let settings = await context.prisma.observabilitySettings.findUnique({
      where: { projectId },
    })

    if (!settings) {
      // Create default settings
      settings = await context.prisma.observabilitySettings.create({
        data: {
          projectId,
          tracesEnabled: true,
          metricsEnabled: true,
          logsEnabled: true,
          traceRetention: 7,
          metricRetention: 30,
          logRetention: 7,
          sampleRate: 1.0,
        },
      })
    }

    return settings
  },

  /**
   * Get telemetry usage summary for a project
   */
  telemetryUsage: async (
    _: unknown,
    {
      projectId,
      startDate,
      endDate,
    }: { projectId: string; startDate: Date; endDate: Date },
    context: Context
  ) => {
    await verifyProjectAccess(projectId, context)

    const service = getTelemetryIngestionService(context.prisma)
    const usage = await service.getProjectUsage(projectId, startDate, endDate)
    const cost = await service.calculateCost(projectId, startDate, endDate)

    return {
      projectId,
      bytesIngested: usage.bytesIngested.toString(),
      bytesFormatted: cost.bytesFormatted,
      spansCount: usage.spansCount,
      metricsCount: usage.metricsCount,
      logsCount: usage.logsCount,
      costCents: cost.costCents,
      costFormatted: cost.costFormatted,
      periodStart: startDate,
      periodEnd: endDate,
    }
  },
}

export const observabilityMutations = {
  /**
   * Update observability settings for a project
   */
  updateObservabilitySettings: async (
    _: unknown,
    {
      projectId,
      input,
    }: {
      projectId: string
      input: {
        tracesEnabled?: boolean
        metricsEnabled?: boolean
        logsEnabled?: boolean
        traceRetention?: number
        metricRetention?: number
        logRetention?: number
        sampleRate?: number
        maxBytesPerHour?: string
      }
    },
    context: Context
  ) => {
    await verifyProjectAccess(projectId, context)

    // Validate inputs
    if (input.sampleRate !== undefined) {
      if (input.sampleRate < 0 || input.sampleRate > 1) {
        throw new GraphQLError('sampleRate must be between 0 and 1')
      }
    }

    if (input.traceRetention !== undefined && input.traceRetention < 1) {
      throw new GraphQLError('traceRetention must be at least 1 day')
    }

    if (input.metricRetention !== undefined && input.metricRetention < 1) {
      throw new GraphQLError('metricRetention must be at least 1 day')
    }

    if (input.logRetention !== undefined && input.logRetention < 1) {
      throw new GraphQLError('logRetention must be at least 1 day')
    }

    // Parse maxBytesPerHour if provided
    let maxBytesPerHour: bigint | null = null
    if (input.maxBytesPerHour !== undefined) {
      if (input.maxBytesPerHour === '' || input.maxBytesPerHour === null) {
        maxBytesPerHour = null
      } else {
        try {
          maxBytesPerHour = BigInt(input.maxBytesPerHour)
        } catch {
          throw new GraphQLError(
            'maxBytesPerHour must be a valid integer string'
          )
        }
      }
    }

    // Upsert settings
    const settings = await context.prisma.observabilitySettings.upsert({
      where: { projectId },
      create: {
        projectId,
        tracesEnabled: input.tracesEnabled ?? true,
        metricsEnabled: input.metricsEnabled ?? true,
        logsEnabled: input.logsEnabled ?? true,
        traceRetention: input.traceRetention ?? 7,
        metricRetention: input.metricRetention ?? 30,
        logRetention: input.logRetention ?? 7,
        sampleRate: input.sampleRate ?? 1.0,
        maxBytesPerHour,
      },
      update: {
        ...(input.tracesEnabled !== undefined && {
          tracesEnabled: input.tracesEnabled,
        }),
        ...(input.metricsEnabled !== undefined && {
          metricsEnabled: input.metricsEnabled,
        }),
        ...(input.logsEnabled !== undefined && {
          logsEnabled: input.logsEnabled,
        }),
        ...(input.traceRetention !== undefined && {
          traceRetention: input.traceRetention,
        }),
        ...(input.metricRetention !== undefined && {
          metricRetention: input.metricRetention,
        }),
        ...(input.logRetention !== undefined && {
          logRetention: input.logRetention,
        }),
        ...(input.sampleRate !== undefined && { sampleRate: input.sampleRate }),
        ...(input.maxBytesPerHour !== undefined && { maxBytesPerHour }),
      },
    })

    return settings
  },
}

export const observabilityResolvers = {
  Query: observabilityQueries,
  Mutation: observabilityMutations,
}
