import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
import { generateInternalHostname } from '../utils/internalHostname.js'
import { generateInvokeUrl } from '../utils/invokeUrl.js'
import { validateRoutes } from '../utils/routeValidation.js'
import { DeploymentService } from '../services/deployment/index.js'
import type { StorageType } from '../services/storage/factory.js'
import { deploymentEvents } from '../services/events/index.js'
import { subscriptionHealthMonitor } from '../services/monitoring/subscriptionHealthCheck.js'
import { chatResolvers } from './chat.js'
import { domainQueries, domainMutations } from './domain.js'
import { authQueries, authMutations } from './auth.js'
import { dnsAdminQueries, dnsAdminMutations } from './dnsAdmin.js'
import {
  observabilityQueries,
  observabilityMutations,
} from './observability.js'
import {
  akashQueries,
  akashMutations,
  akashFieldResolvers,
} from './akash.js'
import {
  templateQueries,
  templateMutations,
} from './templates.js'
import { phalaQueries, phalaMutations, phalaFieldResolvers } from './phala.js'
import {
  serviceConnectivityQueries,
  serviceConnectivityMutations,
  serviceConnectivityFieldResolvers,
} from './serviceConnectivity.js'
import { logsQueries } from './logs.js'
import { StorageTracker } from '../services/billing/storageTracker.js'
import type { Context } from './types.js'

export type { Context }

// Service factory for storage tracking (billing is now handled by service-auth)
const storageTracker = (prisma: any) => new StorageTracker(prisma)

// ── Workspace Metrics Helpers ──────────────────────────────────────

/**
 * Parse CPU (millicores) and memory (MB) from an Akash SDL string.
 * SDL is YAML; we use regex to avoid adding a YAML dependency.
 */
function parseSdlResources(sdl: string): { cpu: number; memory: number } {
  let cpu = 0
  let memory = 0

  // Match cpu units: "units: 0.5" or "units: 500m" inside a cpu block
  const cpuMatches = sdl.match(/cpu:\s*\n\s*units:\s*([0-9.]+)(m?)/g)
  if (cpuMatches) {
    for (const match of cpuMatches) {
      const inner = match.match(/units:\s*([0-9.]+)(m?)/)
      if (inner) {
        const value = parseFloat(inner[1])
        const isMillicores = inner[2] === 'm'
        cpu += isMillicores ? value : value * 1000
      }
    }
  }

  // Match memory size: "size: 512Mi" or "size: 1Gi" or "size: 536870912" (bytes)
  const memMatches = sdl.match(/memory:\s*\n\s*size:\s*([0-9.]+)\s*(Mi|Gi|Ki|Ti|M|G|K|T)?/g)
  if (memMatches) {
    for (const match of memMatches) {
      const inner = match.match(/size:\s*([0-9.]+)\s*(Mi|Gi|Ki|Ti|M|G|K|T)?/)
      if (inner) {
        const value = parseFloat(inner[1])
        const unit = inner[2] || ''
        switch (unit) {
          case 'Ti': case 'T': memory += value * 1024 * 1024; break
          case 'Gi': case 'G': memory += value * 1024; break
          case 'Mi': case 'M': memory += value; break
          case 'Ki': case 'K': memory += value / 1024; break
          default: memory += value / (1024 * 1024); break // assume bytes
        }
      }
    }
  }

  return { cpu: Math.round(cpu), memory: Math.round(memory) }
}

/** Format byte count to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const idx = Math.min(i, units.length - 1)
  const value = bytes / Math.pow(1024, idx)
  return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)} ${units[idx]}`
}

/** Format a count to human-readable (e.g. 12400 → "12.4K") */
function formatCount(n: number): string {
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

export const resolvers = {
  Query: {
    version: () => ({
      commitHash: process.env.COMMIT_HASH || 'dev',
    }),

    me: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }
      return context.prisma.user.findUnique({
        where: { id: context.userId },
      })
    },

    // Projects
    project: async (_: unknown, { id }: { id: string }, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id },
      })
    },

    projects: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }
      // If organizationId is provided, include both:
      // - org-scoped projects for that org
      // - user-owned "personal" projects (organizationId null)
      // This prevents CLI-created personal projects from disappearing in the UI
      // when the UI is operating in an org context.
      const where = context.organizationId
        ? {
            OR: [
              { organizationId: context.organizationId },
              { userId: context.userId, organizationId: null },
            ],
          }
        : { userId: context.userId }
      const data = await context.prisma.project.findMany({
        where,
      })
      // Return wrapped format for SDK compatibility
      return { data }
    },

    // Service registry (canonical workloads)
    serviceRegistry: async (
      _: unknown,
      { projectId }: { projectId?: string | null },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const targetProjectId = projectId ?? context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }

      const project = await context.prisma.project.findUnique({
        where: { id: targetProjectId },
        select: { id: true, userId: true, organizationId: true },
      })
      if (!project) {
        throw new GraphQLError('Project not found')
      }

      const isAuthorized = context.organizationId
        ? project.organizationId === context.organizationId ||
          (project.userId === context.userId && project.organizationId === null)
        : project.userId === context.userId

      if (!isAuthorized) {
        throw new GraphQLError('Not authorized to access this project')
      }

      return context.prisma.service.findMany({
        where: { projectId: targetProjectId },
        orderBy: { createdAt: 'desc' },
      })
    },

    // Sites
    site: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      return context.prisma.site.findUnique({
        where: { id: where.id },
      })
    },

    sites: async (_: unknown, _args: { where?: unknown } | undefined, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }
      const data = await context.prisma.site.findMany({
        where: { projectId: context.projectId },
      })
      // Return wrapped format for SDK compatibility
      return { data }
    },

    siteBySlug: async (
      _: unknown,
      { where }: { where: { slug: string } },
      context: Context
    ) => {
      return context.prisma.site.findUnique({
        where: { slug: where.slug },
      })
    },

    // IPNS Records
    ipnsRecord: async (
      _: unknown,
      { name }: { name: string },
      context: Context
    ) => {
      return context.prisma.iPNSRecord.findUnique({
        where: { name },
      })
    },

    ipnsRecords: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }
      // Get IPNS records for sites in the current project
      const sites = await context.prisma.site.findMany({
        where: { projectId: context.projectId },
        select: { id: true },
      })
      const siteIds = sites.map(s => s.id)
      const data = await context.prisma.iPNSRecord.findMany({
        where: { siteId: { in: siteIds } },
      })
      // Return wrapped format for SDK compatibility
      return { data }
    },

    // Private Gateways (placeholder - returns empty for now as model doesn't exist)
    privateGateway: async (
      _: unknown,
      { id }: { id: string },
      context: Context
    ) => {
      // Private gateways not yet implemented in this API version
      return null
    },

    privateGatewayBySlug: async (
      _: unknown,
      { slug }: { slug: string },
      context: Context
    ) => {
      // Private gateways not yet implemented in this API version
      return null
    },

    privateGateways: async (_: unknown, __: unknown, context: Context) => {
      // Private gateways not yet implemented in this API version
      // Return empty wrapped format for SDK compatibility
      return { data: [] }
    },

    // Deployments (SDK compatibility)
    deployment: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      return context.prisma.deployment.findUnique({
        where: { id: where.id },
      })
    },

    deployments: async (
      _: unknown,
      { siteId }: { siteId?: string },
      context: Context
    ) => {
      if (!siteId && !context.projectId) {
        throw new GraphQLError('Either siteId or project context required')
      }
      if (siteId) {
        return context.prisma.deployment.findMany({
          where: { siteId },
          orderBy: { createdAt: 'desc' },
        })
      }
      // Fall back to all deployments for sites in the current project
      const sites = await context.prisma.site.findMany({
        where: { projectId: context.projectId! },
        select: { id: true },
      })
      return context.prisma.deployment.findMany({
        where: { siteId: { in: sites.map(s => s.id) } },
        orderBy: { createdAt: 'desc' },
      })
    },

    // Zones (SDK compatibility)
    zones: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }

      const sites = await context.prisma.site.findMany({
        where: { projectId: context.projectId },
        select: { id: true },
      })
      const siteIds = sites.map(s => s.id)
      const data = await context.prisma.zone.findMany({
        where: { siteId: { in: siteIds } },
        orderBy: { createdAt: 'desc' },
      })

      return { data }
    },

    zone: async (_: unknown, { id }: { id: string }, context: Context) => {
      return context.prisma.zone.findUnique({ where: { id } })
    },

    // Storage (SDK compatibility - minimal)
    pins: async (_: unknown, __: unknown, context: Context) => {
      // This API doesn't currently expose pins by project; return empty list for CLI compatibility.
      return { data: [] }
    },

    pin: async (_: unknown, { where }: { where: { cid: string } }, context: Context) => {
      return context.prisma.pin.findUnique({ where: { cid: where.cid } })
    },

    pinsByFilename: async (
      _ : unknown,
      { where }: { where: { filename: string; extension?: string } },
      context: Context
    ) => {
      // No filename/extension stored on Pin in this API version
      return { data: [] }
    },

    filecoinDeals: async (
      _: unknown,
      { where }: { where: { cid: string } },
      context: Context
    ) => {
      // Filecoin deals not implemented in this API version
      return { data: [] }
    },

    // ENS (SDK compatibility - minimal)
    ensRecords: async (_: unknown, __: unknown, context: Context) => {
      return { data: [] }
    },

    ensRecordsByIpnsId: async (
      _: unknown,
      { where }: { where: { ipnsRecordId?: string } },
      context: Context
    ) => {
      return { data: [] }
    },

    // Applications (SDK compatibility - minimal)
    applications: async (_: unknown, __: unknown, context: Context) => {
      return { data: [] }
    },

    // Functions
    afFunction: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: where.id },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      return func
    },

    afFunctionByName: async (
      _: unknown,
      { where }: { where: { name: string } },
      context: Context
    ) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }

      const func = await context.prisma.aFFunction.findFirst({
        where: {
          name: where.name,
          projectId: context.projectId,
        },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      return func
    },

    afFunctions: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }
      const data = await context.prisma.aFFunction.findMany({
        where: { projectId: context.projectId },
      })
      // Return wrapped format for SDK compatibility
      return { data }
    },

    afFunctionDeployments: async (
      _: unknown,
      { where }: { where: { afFunctionId?: string; functionId?: string } },
      context: Context
    ) => {
      const afFunctionId = where.afFunctionId || where.functionId
      if (!afFunctionId) {
        throw new GraphQLError('Function ID required')
      }
      const data = await context.prisma.aFFunctionDeployment.findMany({
        where: { afFunctionId },
        orderBy: { createdAt: 'desc' },
      })
      return { data }
    },

    afFunctionDeployment: async (
      _: unknown,
      { where }: { where: { id?: string; cid?: string; functionId?: string } },
      context: Context
    ) => {
      if (where.id) {
        return context.prisma.aFFunctionDeployment.findUnique({
          where: { id: where.id },
        })
      }

      if (where.cid) {
        return context.prisma.aFFunctionDeployment.findFirst({
          where: {
            cid: where.cid,
            ...(where.functionId ? { afFunctionId: where.functionId } : {}),
          },
          orderBy: { createdAt: 'desc' },
        })
      }

      if (where.functionId) {
        return context.prisma.aFFunctionDeployment.findFirst({
          where: { afFunctionId: where.functionId },
          orderBy: { createdAt: 'desc' },
        })
      }

      return null
    },

    // Domains (from domain resolvers)
    ...domainQueries,

    // DNS Admin (from dnsAdmin resolvers)
    ...dnsAdminQueries,

    // Storage Analytics
    storageAnalytics: async (
      _: unknown,
      { projectId }: { projectId?: string },
      context: Context
    ) => {
      const targetProjectId = projectId || context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }

      // Get all sites for this project
      const sites = await context.prisma.site.findMany({
        where: { projectId: targetProjectId },
        include: {
          deployments: {
            include: {
              pin: true,
            },
          },
        },
      })

      // Calculate totals
      let totalSize = 0
      let ipfsSize = 0
      let arweaveSize = 0
      let deploymentCount = 0

      const breakdown: any[] = []

      for (const site of sites) {
        let siteSize = 0
        let siteDeploymentCount = 0
        let lastDeployment: Date | null = null

        for (const deployment of site.deployments) {
          const size = deployment.pin?.size || 0
          siteSize += size
          totalSize += size
          deploymentCount++
          siteDeploymentCount++

          if (deployment.storageType === 'IPFS') {
            ipfsSize += size
          } else if (deployment.storageType === 'ARWEAVE') {
            arweaveSize += size
          }

          if (!lastDeployment || deployment.createdAt > lastDeployment) {
            lastDeployment = deployment.createdAt
          }
        }

        if (siteDeploymentCount > 0) {
          breakdown.push({
            id: site.id,
            name: site.name,
            type: 'SITE',
            size: siteSize,
            deploymentCount: siteDeploymentCount,
            storageType:
              site.deployments[site.deployments.length - 1]?.storageType ||
              'IPFS',
            lastDeployment,
          })
        }
      }

      return {
        totalSize,
        ipfsSize,
        arweaveSize,
        deploymentCount,
        siteCount: sites.length,
        breakdown,
      }
    },

    storageUsageTrend: async (
      _: unknown,
      { projectId, days = 30 }: { projectId?: string; days?: number },
      context: Context
    ) => {
      const targetProjectId = projectId || context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }

      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      // Get all deployments for this project
      const sites = await context.prisma.site.findMany({
        where: { projectId: targetProjectId },
        include: {
          deployments: {
            where: {
              createdAt: {
                gte: startDate,
              },
            },
            include: {
              pin: true,
            },
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      })

      // Group by date
      const trendMap = new Map<
        string,
        { totalSize: number; deploymentCount: number }
      >()

      for (const site of sites) {
        for (const deployment of site.deployments) {
          const dateKey = deployment.createdAt.toISOString().split('T')[0]
          const existing = trendMap.get(dateKey) || {
            totalSize: 0,
            deploymentCount: 0,
          }
          const size = deployment.pin?.size || 0

          trendMap.set(dateKey, {
            totalSize: existing.totalSize + size,
            deploymentCount: existing.deploymentCount + 1,
          })
        }
      }

      // Convert to array and calculate cumulative
      const trend: any[] = []
      let cumulativeSize = 0

      for (const [dateKey, data] of Array.from(trendMap.entries()).sort()) {
        cumulativeSize += data.totalSize
        trend.push({
          date: new Date(dateKey),
          totalSize: cumulativeSize,
          deploymentCount: data.deploymentCount,
        })
      }

      return trend
    },

    // Workspace Metrics (aggregated compute, storage, traffic)
    workspaceMetrics: async (
      _: unknown,
      { projectId }: { projectId?: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const now = new Date()
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

      // ── Compute Metrics ──────────────────────────────────────────
      // Find all active Akash deployments, optionally scoped to a project
      const akashWhere: any = { status: 'ACTIVE' as const }
      if (projectId) {
        akashWhere.service = { projectId }
      } else {
        // Scope to all projects owned by this user
        akashWhere.service = {
          project: { userId: context.userId },
        }
      }

      const activeDeployments = await context.prisma.akashDeployment.findMany({
        where: akashWhere,
        select: { sdlContent: true },
      })

      let totalCpuMillicores = 0
      let totalMemoryMb = 0
      for (const dep of activeDeployments) {
        const { cpu, memory } = parseSdlResources(dep.sdlContent)
        totalCpuMillicores += cpu
        totalMemoryMb += memory
      }

      const cpuFormatted = (totalCpuMillicores / 1000).toFixed(1)
      const memFormatted = totalMemoryMb >= 1024
        ? `${(totalMemoryMb / 1024).toFixed(1)} GB`
        : `${totalMemoryMb} MB`
      const computeFormatted = `${cpuFormatted} vCPU / ${memFormatted}`

      // ── Storage Metrics ──────────────────────────────────────────
      const activePins = await context.prisma.pinnedContent.findMany({
        where: {
          userId: context.userId,
          unpinnedAt: null,
        },
        select: { sizeBytes: true },
      })

      const totalBytes = activePins.reduce(
        (sum: number, pin: { sizeBytes: bigint }) => sum + Number(pin.sizeBytes),
        0
      )
      const pinCount = activePins.length

      const storageFormatted = formatBytes(totalBytes)

      // Storage trend: compare current snapshot to 30 days ago
      const currentSnapshot = await context.prisma.storageSnapshot.findFirst({
        where: { userId: context.userId },
        orderBy: { date: 'desc' },
        select: { totalBytes: true },
      })
      const previousSnapshot = await context.prisma.storageSnapshot.findFirst({
        where: {
          userId: context.userId,
          date: { lte: thirtyDaysAgo },
        },
        orderBy: { date: 'desc' },
        select: { totalBytes: true },
      })

      let storageTrend: number | null = null
      if (currentSnapshot && previousSnapshot) {
        const current = Number(currentSnapshot.totalBytes)
        const previous = Number(previousSnapshot.totalBytes)
        if (previous > 0) {
          storageTrend = ((current - previous) / previous) * 100
        }
      }

      // ── Traffic Metrics ──────────────────────────────────────────
      // Lookup customer for UsageRecord queries
      const customer = await context.prisma.customer.findUnique({
        where: { userId: context.userId },
        select: { id: true },
      })

      let totalRequests = 0
      let totalBandwidthBytes = 0
      let trafficTrend: number | null = null

      if (customer) {
        // Current period (last 30 days)
        const currentRecords = await context.prisma.usageRecord.findMany({
          where: {
            customerId: customer.id,
            type: { in: ['REQUESTS', 'BANDWIDTH'] },
            periodStart: { gte: thirtyDaysAgo },
          },
          select: { type: true, quantity: true },
        })

        for (const rec of currentRecords) {
          if (rec.type === 'REQUESTS') totalRequests += rec.quantity
          if (rec.type === 'BANDWIDTH') totalBandwidthBytes += rec.quantity
        }

        // Previous period (30-60 days ago) for trend
        const previousRecords = await context.prisma.usageRecord.findMany({
          where: {
            customerId: customer.id,
            type: 'REQUESTS',
            periodStart: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
          },
          select: { quantity: true },
        })

        const previousRequests = previousRecords.reduce(
          (sum: number, r: { quantity: number }) => sum + r.quantity,
          0
        )

        if (previousRequests > 0) {
          trafficTrend =
            ((totalRequests - previousRequests) / previousRequests) * 100
        }
      }

      // Also add live counters from UsageBuffer
      const usageBuffer = await context.prisma.usageBuffer.findUnique({
        where: { userId: context.userId },
      })

      if (usageBuffer) {
        totalRequests += usageBuffer.requests
        totalBandwidthBytes += usageBuffer.bandwidth
      }

      const trafficFormatted = formatCount(totalRequests) + ' requests'

      return {
        compute: {
          activeDeploys: activeDeployments.length,
          totalCpuMillicores,
          totalMemoryMb,
          formatted: computeFormatted,
          trend: null, // Compute trend requires historical snapshots not yet tracked
        },
        storage: {
          totalBytes,
          formatted: storageFormatted,
          pinCount,
          trend: storageTrend,
        },
        traffic: {
          totalRequests,
          totalBandwidthBytes,
          formatted: trafficFormatted,
          trend: trafficTrend,
        },
      }
    },

    // Unified Deployments (all deployment types across all services)
    allDeployments: async (
      _: unknown,
      { projectId, limit = 50 }: { projectId?: string; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      // Build project filter: specific project, or all user's projects
      const projectWhere = projectId
        ? { id: projectId }
        : { userId: context.userId }

      const projects = await context.prisma.project.findMany({
        where: projectWhere,
        select: { id: true, name: true },
      })
      const projectIds = projects.map(p => p.id)
      const projectMap = new Map(projects.map(p => [p.id, p.name]))

      if (projectIds.length === 0) return []

      // Fetch the user for author info
      const user = await context.prisma.user.findUnique({
        where: { id: context.userId },
        select: { id: true, username: true, email: true },
      })
      const authorInfo = user
        ? {
            id: user.id,
            name: user.username || user.email || 'Unknown',
            avatarUrl: null,
          }
        : { id: context.userId, name: 'Unknown', avatarUrl: null }

      const unified: Array<{
        id: string
        shortId: string
        status: string
        kind: string
        serviceName: string
        serviceSlug: string | null
        serviceType: string
        projectId: string | null
        projectName: string | null
        source: string
        image: string | null
        statusMessage: string | null
        createdAt: Date
        updatedAt: Date | null
        author: { id: string; name: string; avatarUrl: string | null }
      }> = []

      // 1. Site Deployments (IPFS/Arweave uploads)
      const siteDeployments = await context.prisma.deployment.findMany({
        where: {
          site: { projectId: { in: projectIds } },
        },
        include: {
          site: { select: { name: true, slug: true, projectId: true, serviceId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })

      for (const dep of siteDeployments) {
        const statusMap: Record<string, string> = {
          PENDING: 'QUEUED',
          BUILDING: 'BUILDING',
          UPLOADING: 'DEPLOYING',
          SUCCESS: 'READY',
          FAILED: 'FAILED',
        }
        unified.push({
          id: dep.id,
          shortId: dep.id.slice(-8),
          status: statusMap[dep.status] || dep.status,
          kind: 'SITE',
          serviceName: dep.site?.name || 'Site',
          serviceSlug: dep.site?.slug || null,
          serviceType: 'SITE',
          projectId: dep.site?.projectId || null,
          projectName: dep.site?.projectId ? (projectMap.get(dep.site.projectId) || null) : null,
          source: 'cli',
          image: dep.cid ? `ipfs://${dep.cid}` : null,
          statusMessage: dep.status === 'SUCCESS' ? 'Deployment successful' : null,
          createdAt: dep.createdAt,
          updatedAt: dep.updatedAt,
          author: authorInfo,
        })
      }

      // 2. Function Deployments (code uploads)
      const funcDeployments = await context.prisma.aFFunctionDeployment.findMany({
        where: {
          afFunction: { projectId: { in: projectIds } },
        },
        include: {
          afFunction: { select: { name: true, slug: true, projectId: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })

      for (const dep of funcDeployments) {
        unified.push({
          id: dep.id,
          shortId: dep.id.slice(-8),
          status: dep.afFunction?.status === 'ACTIVE' ? 'ACTIVE' : 'READY',
          kind: 'FUNCTION',
          serviceName: dep.afFunction?.name || 'Function',
          serviceSlug: dep.afFunction?.slug || null,
          serviceType: 'FUNCTION',
          projectId: dep.afFunction?.projectId || null,
          projectName: dep.afFunction?.projectId ? (projectMap.get(dep.afFunction.projectId) || null) : null,
          source: 'cli',
          image: dep.cid ? `ipfs://${dep.cid}` : null,
          statusMessage: 'Function deployed',
          createdAt: dep.createdAt,
          updatedAt: dep.updatedAt,
          author: authorInfo,
        })
      }

      // 3. Akash Deployments (compute containers)
      const akashDeployments = await context.prisma.akashDeployment.findMany({
        where: {
          service: { projectId: { in: projectIds } },
        },
        include: {
          service: { select: { name: true, slug: true, type: true, projectId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })

      for (const dep of akashDeployments) {
        const akashStatusMap: Record<string, string> = {
          CREATING: 'INITIALIZING',
          WAITING_BIDS: 'QUEUED',
          SELECTING_BID: 'QUEUED',
          CREATING_LEASE: 'DEPLOYING',
          SENDING_MANIFEST: 'DEPLOYING',
          DEPLOYING: 'DEPLOYING',
          ACTIVE: 'ACTIVE',
          FAILED: 'FAILED',
          CLOSED: 'REMOVED',
        }

        // Try to extract image from SDL
        const imageMatch = dep.sdlContent.match(/image:\s*["']?([^\s"']+)/)
        const image = imageMatch ? imageMatch[1] : null

        unified.push({
          id: dep.id,
          shortId: dep.id.slice(-8),
          status: akashStatusMap[dep.status] || dep.status,
          kind: 'AKASH',
          serviceName: dep.service?.name || 'Service',
          serviceSlug: dep.service?.slug || null,
          serviceType: dep.service?.type || 'FUNCTION',
          projectId: dep.service?.projectId || null,
          projectName: dep.service?.projectId ? (projectMap.get(dep.service.projectId) || null) : null,
          source: 'docker',
          image,
          statusMessage: dep.errorMessage || (dep.status === 'ACTIVE' ? 'Running on Akash' : null),
          createdAt: dep.createdAt,
          updatedAt: dep.updatedAt,
          author: authorInfo,
        })
      }

      // 4. Phala Deployments (TEE containers)
      const phalaDeployments = await context.prisma.phalaDeployment.findMany({
        where: {
          service: { projectId: { in: projectIds } },
        },
        include: {
          service: { select: { name: true, slug: true, type: true, projectId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })

      for (const dep of phalaDeployments) {
        const phalaStatusMap: Record<string, string> = {
          CREATING: 'INITIALIZING',
          STARTING: 'DEPLOYING',
          ACTIVE: 'ACTIVE',
          FAILED: 'FAILED',
          STOPPED: 'STOPPED',
          DELETED: 'REMOVED',
        }

        unified.push({
          id: dep.id,
          shortId: dep.id.slice(-8),
          status: phalaStatusMap[dep.status] || dep.status,
          kind: 'PHALA',
          serviceName: dep.service?.name || dep.name,
          serviceSlug: dep.service?.slug || null,
          serviceType: dep.service?.type || 'VM',
          projectId: dep.service?.projectId || null,
          projectName: dep.service?.projectId ? (projectMap.get(dep.service.projectId) || null) : null,
          source: 'docker',
          image: null,
          statusMessage: dep.errorMessage || (dep.status === 'ACTIVE' ? 'Running on Phala TEE' : dep.status === 'STOPPED' ? 'Stopped' : null),
          createdAt: dep.createdAt,
          updatedAt: dep.updatedAt,
          author: authorInfo,
        })
      }

      // Sort all by createdAt descending
      unified.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      return unified.slice(0, limit)
    },

    // System Health
    subscriptionHealth: () => {
      return subscriptionHealthMonitor.performHealthCheck()
    },

    // Chat queries (from chat resolvers)
    ...chatResolvers.Query,

    // Auth queries (from auth resolvers)
    ...authQueries,

    // Observability queries (from observability resolvers)
    ...observabilityQueries,

    // Template queries
    ...templateQueries,

    // Akash deployment queries
    ...akashQueries,
    ...phalaQueries,

    // Service container logs
    ...logsQueries,

    // Service connectivity (env vars, ports, links)
    ...serviceConnectivityQueries,

    // Storage tracking queries (billing is now in service-auth)
    pinnedContent: async (
      _: unknown,
      { limit = 100 }: { limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const pins = await storageTracker(context.prisma).getActivePins(
        context.userId,
        limit
      )

      // Convert BigInt to string for GraphQL
      return pins.map((pin: any) => ({
        ...pin,
        sizeBytes: pin.sizeBytes.toString(),
      }))
    },

    storageSnapshots: async (
      _: unknown,
      {
        startDate,
        endDate,
        limit = 30,
      }: { startDate?: Date; endDate?: Date; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const end = endDate || new Date()

      const snapshots = await storageTracker(context.prisma).getSnapshots(
        context.userId,
        start,
        end
      )

      return snapshots.slice(0, limit).map((snapshot: any) => ({
        ...snapshot,
        totalBytes: snapshot.totalBytes.toString(),
      }))
    },

    storageStats: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const currentBytes = await storageTracker(
        context.prisma
      ).getCurrentStorage(context.userId)
      const pinCount = await storageTracker(context.prisma).getPinCount(
        context.userId
      )

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)

      const snapshots = await storageTracker(context.prisma).getSnapshots(
        context.userId,
        yesterday,
        today
      )
      const lastSnapshot =
        snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

      const gb = Number(currentBytes) / (1024 * 1024 * 1024)
      const formatted =
        gb < 0.01 ? `${(gb * 1024).toFixed(2)} MB` : `${gb.toFixed(2)} GB`

      return {
        currentBytes: currentBytes.toString(),
        currentBytesFormatted: formatted,
        pinCount,
        lastSnapshot: lastSnapshot
          ? {
              ...lastSnapshot,
              totalBytes: lastSnapshot.totalBytes.toString(),
            }
          : null,
      }
    },
  },

  Mutation: {
    // Projects
    createProject: async (
      _: unknown,
      { data }: { data: { name: string } },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const { name } = data
      const baseSlug = generateSlug(name)

      // Project.slug is globally unique in Prisma, so repeated creates
      // (or different users choosing the same name) must be disambiguated.
      let slug = baseSlug
      for (let i = 2; i <= 100; i++) {
        const existing = await context.prisma.project.findUnique({
          where: { slug },
        })
        if (!existing) break
        slug = `${baseSlug}-${i}`
      }

      const stillExists = await context.prisma.project.findUnique({
        where: { slug },
      })
      if (stillExists) {
        throw new GraphQLError('Project slug already exists')
      }

      if (context.organizationId) {
        await context.prisma.organization.upsert({
          where: { id: context.organizationId },
          update: {},
          create: { id: context.organizationId },
        })
      }

      return context.prisma.project.create({
        data: {
          name,
          slug,
          userId: context.userId,
          organizationId: context.organizationId,
        },
      })
    },

    deleteProject: async (
      _: unknown,
      { id }: { id: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const project = await context.prisma.project.findUnique({
        where: { id },
        select: { id: true, userId: true, organizationId: true },
      })

      if (!project) {
        throw new GraphQLError('Project not found')
      }

      // Verify ownership: must be the project creator or in the same org
      const isAuthorized = context.organizationId
        ? project.organizationId === context.organizationId
        : project.userId === context.userId

      if (!isAuthorized) {
        throw new GraphQLError('Not authorized to delete this project')
      }

      // Delete all services (cascades to sites, functions, akash deployments)
      await context.prisma.service.deleteMany({
        where: { projectId: id },
      })

      // Delete the project itself
      await context.prisma.project.delete({ where: { id } })

      return true
    },

    // Sites
    createSite: async (
      _: unknown,
      { data }: { data: { name: string } },
      context: Context
    ) => {
      const targetProjectId = context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }

      const slug = generateSlug(data.name)

      return context.prisma.$transaction(async tx => {
        const project = await tx.project.findUniqueOrThrow({ where: { id: targetProjectId } })
        const service = await tx.service.create({
          data: {
            type: 'SITE',
            name: data.name,
            slug,
            projectId: targetProjectId,
            createdByUserId: context.userId ?? null,
            internalHostname: generateInternalHostname(slug, project.slug),
          },
        })

        return tx.site.create({
          data: {
            name: data.name,
            slug,
            projectId: targetProjectId,
            serviceId: service.id,
          },
        })
      })
    },

    deleteSite: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const site = await context.prisma.site.findUnique({
        where: { id: where.id },
        select: {
          id: true,
          name: true,
          slug: true,
          projectId: true,
          serviceId: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      // Ensure site belongs to the current project context (if set)
      if (context.projectId && site.projectId !== context.projectId) {
        throw new GraphQLError('Not authorized to delete this site')
      }

      // Prefer deleting the Service registry entry (cascade should remove the Site)
      if (site.serviceId) {
        await context.prisma.service.delete({ where: { id: site.serviceId } })
        return site
      }

      // Legacy fallback (no serviceId)
      return context.prisma.site.delete({
        where: { id: where.id },
      })
    },

    // Deployments
    createCustomIpfsDeployment: async (
      _: unknown,
      { data }: { data: { siteId: string; cid: string } },
      context: Context
    ) => {
      // Create a deployment record for an existing IPFS CID.
      // Mark as SUCCESS immediately since content already exists.
      return context.prisma.deployment.create({
        data: {
          siteId: data.siteId,
          cid: data.cid,
          storageType: 'IPFS',
          status: 'SUCCESS',
        },
      })
    },

    createDeployment: async (
      _: unknown,
      {
        siteId,
        sourceDirectory,
        storageType = 'IPFS',
        buildOptions,
      }: {
        siteId: string
        sourceDirectory: string
        storageType?: StorageType
        buildOptions?: {
          buildCommand: string
          installCommand?: string
          workingDirectory?: string
          outputDirectory?: string
        }
      },
      context: Context
    ) => {
      // Verify site exists
      const site = await context.prisma.site.findUnique({
        where: { id: siteId },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      const deploymentService = new DeploymentService(context.prisma)

      const result = await deploymentService.deploy({
        siteId,
        sourceDirectory,
        storageType,
        buildOptions,
        outputDirectory: buildOptions?.outputDirectory,
      })

      // Return the created deployment
      const deployment = await context.prisma.deployment.findUnique({
        where: { id: result.deploymentId },
      })

      if (!deployment) {
        throw new GraphQLError('Deployment not found after creation')
      }

      return deployment
    },

    // Functions
    createAFFunction: async (
      _: unknown,
      {
        data,
      }: { data: { name?: string; siteId?: string; slug?: string; sourceCode?: string; routes?: any; status?: string } },
      context: Context
    ) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required')
      }

      if (!data?.name) {
        throw new GraphQLError('Function name required')
      }

      const name = data.name

      // Validate routes if provided
      if (data.routes !== undefined && data.routes !== null) {
        validateRoutes(data.routes)
      }

      const slug = data.slug || generateSlug(name)
      const invokeUrl = generateInvokeUrl(slug)

      return context.prisma.$transaction(async tx => {
        const project = await tx.project.findUniqueOrThrow({ where: { id: context.projectId! } })
        const service = await tx.service.create({
          data: {
            type: 'FUNCTION',
            name,
            slug,
            projectId: context.projectId!,
            createdByUserId: context.userId ?? null,
            internalHostname: generateInternalHostname(slug, project.slug),
          },
        })

        return tx.aFFunction.create({
          data: {
            name,
            slug,
            sourceCode: data.sourceCode,
            invokeUrl,
            projectId: context.projectId!,
            siteId: data.siteId,
            serviceId: service.id,
            routes: data.routes === null ? null : (data.routes ?? undefined),
            status: (data.status as any) || 'ACTIVE',
          },
        })
      })
    },

    triggerAFFunctionDeployment: async (
      _: unknown,
      {
        where,
        data,
      }: {
        where: { functionId: string; cid?: string | null }
        data?:
          | { cid?: string | null; sgx?: boolean; blake3Hash?: string; assetsCid?: string }
          | null
      },
      context: Context
    ) => {
      const cid = where.cid ?? data?.cid
      if (!cid) {
        throw new GraphQLError('CID required')
      }

      const deployment = await context.prisma.aFFunctionDeployment.create({
        data: {
          cid,
          sgx: data?.sgx ?? false,
          blake3Hash: data?.blake3Hash,
          assetsCid: data?.assetsCid,
          afFunctionId: where.functionId,
        },
      })

      // Update function's current deployment
      await context.prisma.aFFunction.update({
        where: { id: where.functionId },
        data: {
          currentDeploymentId: deployment.id,
          status: 'ACTIVE',
        },
      })

      return deployment
    },

    updateAFFunction: async (
      _: unknown,
      {
        where,
        data,
      }: {
        where: { id: string }
        data: { name?: string; slug?: string; sourceCode?: string; siteId?: string; routes?: any; status?: string } | null
      },
      context: Context
    ) => {
      // Validate routes if provided
      if (data?.routes !== undefined && data?.routes !== null) {
        validateRoutes(data.routes)
      }

      const invokeUrl =
        data?.slug !== undefined && data?.slug !== null
          ? generateInvokeUrl(data.slug)
          : undefined

      return context.prisma.aFFunction.update({
        where: { id: where.id },
        data: {
          ...(data?.name !== undefined ? { name: data.name } : {}),
          ...(data?.slug !== undefined ? { slug: data.slug } : {}),
          ...(data?.sourceCode !== undefined ? { sourceCode: data.sourceCode } : {}),
          ...(invokeUrl !== undefined ? { invokeUrl } : {}),
          ...(data?.siteId !== undefined ? { siteId: data.siteId } : {}),
          ...(data?.routes !== undefined ? { routes: data.routes } : {}),
          ...(data?.status !== undefined ? { status: data.status as any } : {}),
        },
      })
    },

    deleteAFFunction: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: where.id },
        select: {
          id: true,
          name: true,
          slug: true,
          invokeUrl: true,
          routes: true,
          status: true,
          projectId: true,
          siteId: true,
          currentDeploymentId: true,
          createdAt: true,
          updatedAt: true,
          serviceId: true,
        },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      if (context.projectId && func.projectId !== context.projectId) {
        throw new GraphQLError('Not authorized to delete this function')
      }

      // Prefer deleting the Service registry entry (cascade should remove the function)
      if (func.serviceId) {
        await context.prisma.service.delete({ where: { id: func.serviceId } })
        return func
      }

      // Legacy fallback (no serviceId)
      return context.prisma.aFFunction.delete({
        where: { id: where.id },
      })
    },

    deleteService: async (
      _: unknown,
      { id }: { id: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const service = await context.prisma.service.findUnique({
        where: { id },
        include: {
          akashDeployments: {
            where: { status: { notIn: ['CLOSED', 'FAILED'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          phalaDeployments: {
            where: { status: { notIn: ['DELETED', 'STOPPED', 'FAILED'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      })

      if (!service) {
        throw new GraphQLError('Service not found')
      }

      if (context.projectId && service.projectId !== context.projectId) {
        throw new GraphQLError('Not authorized to delete this service')
      }

      // Guard: block deletion if any provider has an active/in-progress deployment
      const activeAkash = service.akashDeployments[0]
      if (activeAkash) {
        throw new GraphQLError(
          `Cannot delete "${service.name}" — it has an active Akash deployment (${activeAkash.status}). Close the deployment first.`
        )
      }

      const activePhala = service.phalaDeployments[0]
      if (activePhala) {
        throw new GraphQLError(
          `Cannot delete "${service.name}" — it has an active Phala deployment (${activePhala.status}). Stop or delete the deployment first.`
        )
      }

      await context.prisma.service.delete({ where: { id } })
      return service
    },

    // Domains (from domain resolvers)
    ...domainMutations,

    // DNS Admin (from dnsAdmin resolvers)
    ...dnsAdminMutations,

    // Chat mutations (from chat resolvers)
    ...chatResolvers.Mutation,

    // Auth mutations (from auth resolvers)
    ...authMutations,

    // Observability mutations (from observability resolvers)
    ...observabilityMutations,

    // Template mutations
    ...templateMutations,

    // Akash deployment mutations
    ...akashMutations,

    // Phala deployment mutations
    ...phalaMutations,

    // Service connectivity mutations (env vars, ports, links)
    ...serviceConnectivityMutations,

    // Storage tracking mutation (billing is now in service-auth)
    triggerStorageSnapshot: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const snapshotId = await storageTracker(
        context.prisma
      ).createDailySnapshot(context.userId)

      const snapshot = await context.prisma.storageSnapshot.findUnique({
        where: { id: snapshotId },
      })

      if (!snapshot) {
        throw new GraphQLError('Failed to create snapshot')
      }

      return {
        ...snapshot,
        totalBytes: snapshot.totalBytes.toString(),
      }
    },
  },

  // Field resolvers
  User: {
    projects: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findMany({
        where: { userId: parent.id },
      })
    },
  },

  Project: {
    user: (parent: any, _: unknown, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
    sites: (parent: any, _: unknown, context: Context) => {
      return context.prisma.site.findMany({
        where: { projectId: parent.id },
      })
    },
    functions: (parent: any, _: unknown, context: Context) => {
      return context.prisma.aFFunction.findMany({
        where: { projectId: parent.id },
      })
    },
  },

  Service: {
    site: async (parent: any, _: unknown, context: Context) => {
      if (parent.type !== 'SITE') return null
      return context.prisma.site.findUnique({
        where: { serviceId: parent.id },
      })
    },
    afFunction: async (parent: any, _: unknown, context: Context) => {
      if (parent.type !== 'FUNCTION') return null
      return context.prisma.aFFunction.findUnique({
        where: { serviceId: parent.id },
      })
    },
    // Merge Akash-related Service field resolvers (akashDeployments, activeAkashDeployment)
    ...(akashFieldResolvers.Service ?? {}),
    // Merge Phala-related Service field resolvers (phalaDeployments, activePhalaDeployment)
    ...(phalaFieldResolvers.Service ?? {}),
    // Merge inter-service communication field resolvers (envVars, ports, linksFrom, linksTo)
    ...(serviceConnectivityFieldResolvers.Service ?? {}),
  },

  ServiceLink: {
    ...(serviceConnectivityFieldResolvers.ServiceLink ?? {}),
  },

  Site: {
    project: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id: parent.projectId },
      })
    },
    zones: (parent: any, _: unknown, context: Context) => {
      return context.prisma.zone.findMany({
        where: { siteId: parent.id },
      })
    },
    ipnsRecords: (parent: any, _: unknown, context: Context) => {
      return context.prisma.iPNSRecord.findMany({
        where: { siteId: parent.id },
      })
    },
    deployments: (parent: any, _: unknown, context: Context) => {
      return context.prisma.deployment.findMany({
        where: { siteId: parent.id },
      })
    },
    domains: (parent: any, _: unknown, context: Context) => {
      return context.prisma.domain.findMany({
        where: { siteId: parent.id },
      })
    },
    akashDeployments: async (parent: any, _: unknown, context: Context) => {
      const deployments = await context.prisma.akashDeployment.findMany({
        where: { siteId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
      return deployments.map(d => ({
        ...d,
        dseq: d.dseq.toString(),
        depositUakt: d.depositUakt?.toString(),
      }))
    },
  },

  Domain: {
    isVerified: (parent: any) => !!parent.verified,
    dnsConfigs: (parent: any) => {
      const configs: any[] = []

      if (parent.expectedCname) {
        configs.push({
          id: `${parent.id}-cname`,
          type: 'CNAME',
          name: '@',
          value: parent.expectedCname,
          createdAt: parent.createdAt,
          updatedAt: parent.updatedAt,
        })
      }

      if (parent.txtVerificationToken) {
        configs.push({
          id: `${parent.id}-txt`,
          type: 'TXT',
          name: '@',
          value: parent.txtVerificationToken,
          createdAt: parent.createdAt,
          updatedAt: parent.updatedAt,
        })
      }

      return configs
    },
    zone: async (parent: any, _: unknown, context: Context) => {
      // Our Domain model doesn't store a zoneId; infer via its site -> zones
      const zones = await context.prisma.zone.findMany({
        where: { siteId: parent.siteId },
        orderBy: { createdAt: 'asc' },
        take: 1,
      })
      return zones[0] || null
    },
  },

  IPNSRecord: {
    ensRecords: () => [],
  },

  Application: {
    whitelistDomains: () => [],
    whiteLabelDomains: () => [],
  },

  AFFunction: {
    project: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id: parent.projectId },
      })
    },
    currentDeployment: (parent: any, _: unknown, context: Context) => {
      if (!parent.currentDeploymentId) return null
      return context.prisma.aFFunctionDeployment.findUnique({
        where: { id: parent.currentDeploymentId },
      })
    },
    deployments: (parent: any, _: unknown, context: Context) => {
      return context.prisma.aFFunctionDeployment.findMany({
        where: { afFunctionId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
    akashDeployments: async (parent: any, _: unknown, context: Context) => {
      const deployments = await context.prisma.akashDeployment.findMany({
        where: { afFunctionId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
      return deployments.map(d => ({
        ...d,
        dseq: d.dseq.toString(),
        depositUakt: d.depositUakt?.toString(),
      }))
    },
  },

  AFFunctionDeployment: {
    afFunction: (parent: any, _: unknown, context: Context) => {
      return context.prisma.aFFunction.findUnique({
        where: { id: parent.afFunctionId },
      })
    },
  },

  // Chat field resolvers
  Agent: chatResolvers.Agent,
  Chat: chatResolvers.Chat,
  Message: chatResolvers.Message,

  // Storage tracking field resolvers
  PinnedContent: {
    user: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
  },

  StorageSnapshot: {
    user: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
  },

  // Akash deployment field resolvers
  AkashDeployment: akashFieldResolvers.AkashDeployment,

  // Phala deployment field resolvers
  PhalaDeployment: phalaFieldResolvers.PhalaDeployment,

  // Subscriptions for real-time updates
  Subscription: {
    // GraphQL subscription operations
    deploymentLogs: {
      subscribe: async function* (
        _: unknown,
        { deploymentId }: { deploymentId: string },
        context: Context
      ) {
        // Verify deployment exists
        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
        })

        if (!deployment) {
          subscriptionHealthMonitor.trackError(
            'Deployment not found',
            deploymentId
          )
          throw new GraphQLError('Deployment not found')
        }

        // Track subscription creation
        subscriptionHealthMonitor.trackSubscriptionCreated(deploymentId)

        // Create an async generator that yields log events
        const queue: any[] = []
        // eslint-disable-next-line no-unused-vars
        let resolve: ((value: IteratorResult<any>) => void) | null = null

        const handler = (event: any) => {
          subscriptionHealthMonitor.trackEventEmitted()
          if (resolve) {
            resolve({ value: event, done: false })
            resolve = null
          } else {
            queue.push(event)
          }
        }

        deploymentEvents.onLog(deploymentId, handler)

        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()
            } else {
              await new Promise<void>(res => {
                resolve = result => {
                  if (!result.done) {
                    res()
                  }
                }
              })

              if (queue.length > 0) {
                yield queue.shift()
              }
            }
          }
        } catch (error) {
          subscriptionHealthMonitor.trackError(
            error instanceof Error ? error.message : 'Unknown error',
            deploymentId
          )
          throw error
        } finally {
          deploymentEvents.removeLogListener(deploymentId, handler)
          subscriptionHealthMonitor.trackSubscriptionClosed(deploymentId)
        }
      },
      resolve: (payload: any) => payload,
    },

    deploymentStatus: {
      subscribe: async function* (
        _: unknown,
        { deploymentId }: { deploymentId: string },
        context: Context
      ) {
        // Verify deployment exists
        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
        })

        if (!deployment) {
          subscriptionHealthMonitor.trackError(
            'Deployment not found',
            deploymentId
          )
          throw new GraphQLError('Deployment not found')
        }

        // Track subscription creation
        subscriptionHealthMonitor.trackSubscriptionCreated(deploymentId)

        // Create an async generator that yields status events
        const queue: any[] = []
        // eslint-disable-next-line no-unused-vars
        let resolve: ((value: IteratorResult<any>) => void) | null = null

        const handler = (event: any) => {
          subscriptionHealthMonitor.trackEventEmitted()
          if (resolve) {
            resolve({ value: event, done: false })
            resolve = null
          } else {
            queue.push(event)
          }
        }

        deploymentEvents.onStatus(deploymentId, handler)

        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()
            } else {
              await new Promise<void>(res => {
                resolve = result => {
                  if (!result.done) {
                    res()
                  }
                }
              })

              if (queue.length > 0) {
                yield queue.shift()
              }
            }
          }
        } catch (error) {
          subscriptionHealthMonitor.trackError(
            error instanceof Error ? error.message : 'Unknown error',
            deploymentId
          )
          throw error
        } finally {
          deploymentEvents.removeStatusListener(deploymentId, handler)
          subscriptionHealthMonitor.trackSubscriptionClosed(deploymentId)
        }
      },
      resolve: (payload: any) => payload,
    },
  },
}
