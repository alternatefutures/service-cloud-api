import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
import { generateInternalHostname } from '../utils/internalHostname.js'
import { generateInvokeUrl } from '../utils/invokeUrl.js'
import { validateRoutes } from '../utils/routeValidation.js'
import { DeploymentService } from '../services/deployment/index.js'
import type { StorageType } from '../services/storage/factory.js'
import { deploymentEvents } from '../services/events/index.js'
import { subscriptionHealthMonitor } from '../services/monitoring/subscriptionHealthCheck.js'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import {
  countActiveDeploymentsForProjects,
  countTotalDeploymentsForProjects,
  findActiveOrPendingDeploymentForService,
  findAllNonTerminalDeploymentsForService,
  findRecentDeploymentsForProjects,
  getAllProviders,
} from '../services/providers/registry.js'
import { AKASH_PENDING_STATUSES } from '../services/providers/akashProvider.js'
import { chatResolvers } from './chat.js'
import { feedbackMutations } from './feedback.js'
import { domainQueries, domainMutations } from './domain.js'
import { authQueries, authMutations } from './auth.js'
import {
  dnsAdminQueries,
  dnsAdminMutations,
  domainRegistrationQueries,
  domainRegistrationMutations,
} from './dnsAdmin.js'
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
  templateFieldResolvers,
} from './templates.js'
import { getTemplateById } from '../templates/registry.js'
import { injectPlatformEnvVars } from '../services/billing/platformEnvClient.js'
import { phalaQueries, phalaMutations, phalaFieldResolvers } from './phala.js'
import { spheronQueries, spheronMutations, spheronFieldResolvers } from './spheron.js'
import { regionsQueries } from './regions.js'
import { githubQueries, githubMutations, githubFieldResolvers } from './github.js'
import {
  serviceConnectivityQueries,
  serviceConnectivityMutations,
  serviceConnectivityFieldResolvers,
} from './serviceConnectivity.js'
import { logsQueries } from './logs.js'
import { healthQueries } from './health.js'
import { StorageTracker } from '../services/billing/storageTracker.js'
import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { getOrgHourlyBurnCents } from './balanceCheck.js'

export type { Context }

// Service factory for storage tracking (billing is now handled by service-auth)
const storageTracker = (prisma: any) => new StorageTracker(prisma)
 
/**
 * Validate that context.projectId is owned by the authenticated user.
 * Prevents IDOR via spoofed x-project-id header.
 */
async function requireOwnedProjectContext(context: Context, projectId?: string): Promise<string> {
  requireAuth(context)
  const pid = projectId || context.projectId
  if (!pid) {
    throw new GraphQLError('Project ID required', { extensions: { code: 'BAD_USER_INPUT' } })
  }
  const project = await context.prisma.project.findUnique({
    where: { id: pid },
    select: { userId: true, organizationId: true },
  })
  if (!project) {
    throw new GraphQLError('Project not found', { extensions: { code: 'NOT_FOUND' } })
  }
  assertProjectAccess(context, project)
  return pid
}

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

/**
 * Static Phala instance-type → vcpu/memory map. Used by `workspaceMetrics`
 * to roll Phala compute into the dashboard total without an upstream call.
 * Mirrors `phala/instanceTypes.ts` FALLBACK_INSTANCE_TYPES so a Phala API
 * outage doesn't blank the dashboard. Update both when Phala adds SKUs.
 */
const FALLBACK_PHALA_SPECS: Record<string, { vcpu: number; memoryMb: number }> = {
  'tdx.small':    { vcpu: 1,   memoryMb: 2048 },
  'tdx.medium':   { vcpu: 2,   memoryMb: 4096 },
  'tdx.large':    { vcpu: 4,   memoryMb: 8192 },
  'tdx.xlarge':   { vcpu: 8,   memoryMb: 16384 },
  'h100.small':   { vcpu: 16,  memoryMb: 131072 },
  'h200.small':   { vcpu: 24,  memoryMb: 196608 },
  'h200.8x.large': { vcpu: 192, memoryMb: 1572864 },
  'b200.small':   { vcpu: 32,  memoryMb: 262144 },
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

    project: async (_: unknown, { id }: { id: string }, context: Context) => {
      requireAuth(context)
      const project = await context.prisma.project.findUnique({
        where: { id },
      })
      if (!project) return null
      assertProjectAccess(context, project)
      return project
    },

    projects: async (_: unknown, __: unknown, context: Context) => {
      requireAuth(context)
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

    serviceRegistry: async (
      _: unknown,
      { projectId }: { projectId?: string | null },
      context: Context
    ) => {
      requireAuth(context)

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
      assertProjectAccess(context, project)

      return context.prisma.service.findMany({
        where: { projectId: targetProjectId },
        orderBy: { createdAt: 'desc' },
      })
    },

    // Fixed by audit 2026-03: added auth + ownership check (was unauthenticated)
    site: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }
      const site = await context.prisma.site.findUnique({
        where: { id: where.id },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!site) return null
      const p = (site as any).project
      if (p) assertProjectAccess(context, p, 'Not authorized to access this site')
      return site
    },

    sites: async (_: unknown, _args: { where?: unknown } | undefined, context: Context) => {
      const projectId = await requireOwnedProjectContext(context)
      const data = await context.prisma.site.findMany({
        where: { projectId },
      })
      return { data }
    },

    siteBySlug: async (
      _: unknown,
      { where }: { where: { slug: string } },
      context: Context
    ) => {
      requireAuth(context)
      const site = await context.prisma.site.findUnique({
        where: { slug: where.slug },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!site) return null
      const p = (site as any).project
      if (p) assertProjectAccess(context, p, 'Not authorized to access this site')
      return site
    },

    ipnsRecord: async (
      _: unknown,
      { name }: { name: string },
      context: Context
    ) => {
      requireAuth(context)
      const record = await context.prisma.iPNSRecord.findUnique({
        where: { name },
        include: { site: { include: { project: { select: { userId: true, organizationId: true } } } } },
      })
      if (!record) return null
      if ((record as any).site?.project) {
        assertProjectAccess(context, (record as any).site.project)
      }
      return record
    },

    ipnsRecords: async (_: unknown, __: unknown, context: Context) => {
      const projectId = await requireOwnedProjectContext(context)
      const sites = await context.prisma.site.findMany({
        where: { projectId },
        select: { id: true },
      })
      const siteIds = sites.map(s => s.id)
      const data = await context.prisma.iPNSRecord.findMany({
        where: { siteId: { in: siteIds } },
      })
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

    deployment: async (
      _: unknown,
      { where }: { where: { id: string } },
      context: Context
    ) => {
      requireAuth(context)
      const deployment = await context.prisma.deployment.findUnique({
        where: { id: where.id },
        include: { site: { include: { project: { select: { userId: true, organizationId: true } } } } },
      })
      if (!deployment) return null
      if ((deployment as any).site?.project) {
        assertProjectAccess(context, (deployment as any).site.project)
      }
      return deployment
    },

    deployments: async (
      _: unknown,
      { siteId }: { siteId?: string },
      context: Context
    ) => {
      requireAuth(context)
      if (siteId) {
        const site = await context.prisma.site.findUnique({
          where: { id: siteId },
          include: { project: { select: { userId: true, organizationId: true } } },
        })
        if (!site) throw new GraphQLError('Site not found')
        assertProjectAccess(context, (site as any).project)
        return context.prisma.deployment.findMany({
          where: { siteId },
          orderBy: { createdAt: 'desc' },
        })
      }
      const projectId = await requireOwnedProjectContext(context)
      const sites = await context.prisma.site.findMany({
        where: { projectId },
        select: { id: true },
      })
      return context.prisma.deployment.findMany({
        where: { siteId: { in: sites.map(s => s.id) } },
        orderBy: { createdAt: 'desc' },
      })
    },

    // Zones (SDK compatibility)
    zones: async (_: unknown, __: unknown, context: Context) => {
      const projectId = await requireOwnedProjectContext(context)

      const sites = await context.prisma.site.findMany({
        where: { projectId },
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
      requireAuth(context)
      const zone = await context.prisma.zone.findUnique({
        where: { id },
        include: { site: { include: { project: { select: { userId: true, organizationId: true } } } } },
      })
      if (!zone) return null
      if ((zone as any).site?.project) {
        assertProjectAccess(context, (zone as any).site.project)
      }
      return zone
    },

    // Storage (SDK compatibility - minimal)
    pins: async (_: unknown, __: unknown, context: Context) => {
      // This API doesn't currently expose pins by project; return empty list for CLI compatibility.
      return { data: [] }
    },

    pin: async (_: unknown, { where }: { where: { cid: string } }, context: Context) => {
      requireAuth(context)
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
      requireAuth(context)
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: where.id },
        include: { project: { select: { userId: true, organizationId: true } } },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      assertProjectAccess(context, (func as any).project)
      return func
    },

    afFunctionByName: async (
      _: unknown,
      { where }: { where: { name: string } },
      context: Context
    ) => {
      const projectId = await requireOwnedProjectContext(context)

      const func = await context.prisma.aFFunction.findFirst({
        where: {
          name: where.name,
          projectId,
        },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      return func
    },

    afFunctions: async (_: unknown, __: unknown, context: Context) => {
      const projectId = await requireOwnedProjectContext(context)
      const data = await context.prisma.aFFunction.findMany({
        where: { projectId },
      })
      // Return wrapped format for SDK compatibility
      return { data }
    },

    afFunctionDeployments: async (
      _: unknown,
      { where }: { where: { afFunctionId?: string; functionId?: string } },
      context: Context
    ) => {
      requireAuth(context)
      const afFunctionId = where.afFunctionId || where.functionId
      if (!afFunctionId) {
        throw new GraphQLError('Function ID required')
      }
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: afFunctionId },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!func) {
        throw new GraphQLError('Function not found')
      }
      assertProjectAccess(context, (func as any).project)
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
      requireAuth(context)

      let deployment: any = null
      if (where.id) {
        deployment = await context.prisma.aFFunctionDeployment.findUnique({
          where: { id: where.id },
          include: { afFunction: { include: { project: { select: { userId: true, organizationId: true } } } } },
        })
      } else if (where.cid) {
        deployment = await context.prisma.aFFunctionDeployment.findFirst({
          where: {
            cid: where.cid,
            ...(where.functionId ? { afFunctionId: where.functionId } : {}),
          },
          include: { afFunction: { include: { project: { select: { userId: true, organizationId: true } } } } },
          orderBy: { createdAt: 'desc' },
        })
      } else if (where.functionId) {
        deployment = await context.prisma.aFFunctionDeployment.findFirst({
          where: { afFunctionId: where.functionId },
          include: { afFunction: { include: { project: { select: { userId: true, organizationId: true } } } } },
          orderBy: { createdAt: 'desc' },
        })
      }

      if (deployment?.afFunction?.project) {
        assertProjectAccess(context, deployment.afFunction.project)
      }
      return deployment
    },

    // Domains (from domain resolvers)
    ...domainQueries,

    // DNS Admin (from dnsAdmin resolvers)
    ...dnsAdminQueries,

    // Domain Registration / Purchase
    ...domainRegistrationQueries,

    // Storage Analytics
    storageAnalytics: async (
      _: unknown,
      { projectId }: { projectId?: string },
      context: Context
    ) => {
      requireAuth(context)
      const targetProjectId = projectId || context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }
      await requireOwnedProjectContext(context, targetProjectId)

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
      requireAuth(context)
      const targetProjectId = projectId || context.projectId
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required')
      }
      await requireOwnedProjectContext(context, targetProjectId)

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

    // Workspace Metrics (compute, deployments, spend)
    workspaceMetrics: async (
      _: unknown,
      { projectId }: { projectId?: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const ownershipFilter = context.organizationId
        ? {
            OR: [
              { organizationId: context.organizationId },
              { userId: context.userId, organizationId: null },
            ],
          }
        : { userId: context.userId }

      const projectWhere = projectId
        ? { id: projectId, ...ownershipFilter }
        : ownershipFilter

      const projectIds = (
        await context.prisma.project.findMany({
          where: projectWhere,
          select: { id: true },
        })
      ).map((p) => p.id)

      // ── Compute Metrics ──────────────────────────────────────────
      // Sum cpu / memory across ALL active providers, not just Akash.
      // Akash → parse SDL `compute.resources` block.
      // Phala → look up the cvmSize in the static instance-types catalog.
      // Spheron → read pricedSnapshotJson (vcpus + memory in GB).
      const activeAkash = await context.prisma.akashDeployment.findMany({
        where: {
          status: 'ACTIVE',
          service: { projectId: { in: projectIds } },
        },
        select: { sdlContent: true },
      })

      let totalCpuMillicores = 0
      let totalMemoryMb = 0
      for (const dep of activeAkash) {
        const { cpu, memory } = parseSdlResources(dep.sdlContent)
        totalCpuMillicores += cpu
        totalMemoryMb += memory
      }

      const activePhala = await context.prisma.phalaDeployment.findMany({
        where: {
          status: 'ACTIVE',
          service: { projectId: { in: projectIds } },
        },
        select: { cvmSize: true },
      })
      for (const dep of activePhala) {
        const spec = dep.cvmSize ? FALLBACK_PHALA_SPECS[dep.cvmSize] : undefined
        if (spec) {
          totalCpuMillicores += spec.vcpu * 1000
          totalMemoryMb += spec.memoryMb
        }
      }

      const activeSpheron = await context.prisma.spheronDeployment.findMany({
        where: {
          status: 'ACTIVE',
          service: { projectId: { in: projectIds } },
        },
        select: { pricedSnapshotJson: true },
      })
      for (const dep of activeSpheron) {
        const snap = dep.pricedSnapshotJson as { vcpus?: number; memory?: number } | null
        if (snap?.vcpus) totalCpuMillicores += snap.vcpus * 1000
        if (snap?.memory) totalMemoryMb += snap.memory * 1024
      }

      const totalActiveCompute =
        activeAkash.length + activePhala.length + activeSpheron.length

      const cpuFormatted = (totalCpuMillicores / 1000).toFixed(1)
      const memFormatted = totalMemoryMb >= 1024
        ? `${(totalMemoryMb / 1024).toFixed(1)} GB`
        : `${totalMemoryMb} MB`
      const computeFormatted = totalActiveCompute > 0
        ? `${cpuFormatted} vCPU / ${memFormatted}`
        : '--'

      // ── Deployment Metrics ────────────────────────────────────────
      // Counts loop over the provider registry. Each provider's descriptor
      // declares its liveStatuses (Akash + Phala = ACTIVE only,
      // Spheron = CREATING/STARTING/ACTIVE because hourly billing is
      // already accruing).
      const activeCount = await countActiveDeploymentsForProjects(
        context.prisma,
        projectIds,
      )
      const totalCount = await countTotalDeploymentsForProjects(
        context.prisma,
        projectIds,
      )
      const deploymentsFormatted = `${activeCount} active`

      // ── Spend Metrics (real ledger data from auth service) ────────
      let currentMonthCents = 0

      // Resolve org: context may have it, or derive from projects
      let spendOrgId = context.organizationId
      if (!spendOrgId && projectIds.length > 0) {
        const firstProject = await context.prisma.project.findFirst({
          where: { id: { in: projectIds } },
          select: { organizationId: true },
        })
        spendOrgId = firstProject?.organizationId ?? undefined
      }

      if (spendOrgId) {
        try {
          const billingClient = getBillingApiClient()
          const spend = await billingClient.getOrgMonthlySpend(spendOrgId)
          currentMonthCents = spend.currentMonthCents
        } catch (err) {
          console.warn('[workspaceMetrics] Failed to fetch monthly spend from auth:', err)
        }
      }

      const spendFormatted = currentMonthCents > 0
        ? `$${(currentMonthCents / 100).toFixed(2)}`
        : '$0.00'

      return {
        compute: {
          activeDeploys: totalActiveCompute,
          totalCpuMillicores,
          totalMemoryMb,
          formatted: computeFormatted,
        },
        deployments: {
          active: activeCount,
          total: totalCount,
          formatted: deploymentsFormatted,
        },
        spend: {
          currentMonthCents,
          formatted: spendFormatted,
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

      const ownershipFilter = context.organizationId
        ? {
            OR: [
              { organizationId: context.organizationId },
              { userId: context.userId, organizationId: null },
            ],
          }
        : { userId: context.userId }

      const projectWhere = projectId
        ? { id: projectId, ...ownershipFilter }
        : ownershipFilter

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
        serviceId: string | null
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
          serviceId: dep.site?.serviceId || null,
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
          afFunction: { select: { name: true, slug: true, projectId: true, status: true, serviceId: true } },
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
          serviceId: dep.afFunction?.serviceId || null,
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

      // 3-N. Compute provider deployments — loop over the provider
      // registry so adding a new backend doesn't require a new block here.
      // Each provider's descriptor supplies the unifiedStatusMap, and the
      // provider class supplies extractImage/describeUnifiedStatus. The
      // resolver's job is only the per-row shape + author info.
      const recentByProvider = await findRecentDeploymentsForProjects(
        context.prisma,
        projectIds,
        limit,
      )
      for (const row of recentByProvider) {
        const dep = row.deployment as {
          id: string
          serviceId: string
          createdAt: Date
          updatedAt: Date | null
          name?: string
          errorMessage?: string | null
          service?: { name?: string; slug?: string | null; type?: string; projectId?: string }
        } & Record<string, unknown>
        const provider = getAllProviders().find(p => p.name === row.providerName)
        const image = provider?.extractImage?.(dep) ?? null
        const statusMessage = provider?.describeUnifiedStatus?.({
          status: row.nativeStatus,
          errorMessage: dep.errorMessage ?? null,
          ...dep,
        }) ?? dep.errorMessage ?? null
        const fallbackType = row.providerName === 'akash' ? 'FUNCTION' : 'VM'
        unified.push({
          id: dep.id,
          shortId: dep.id.slice(-8),
          status: row.unifiedStatus,
          kind: row.providerName.toUpperCase(),
          serviceName: dep.service?.name || dep.name || 'Service',
          serviceId: dep.serviceId,
          serviceSlug: dep.service?.slug || null,
          serviceType: dep.service?.type || fallbackType,
          projectId: dep.service?.projectId || null,
          projectName: dep.service?.projectId
            ? projectMap.get(dep.service.projectId) || null
            : null,
          source: 'docker',
          image,
          statusMessage,
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

    // Spheron GPU VM deployment queries
    ...spheronQueries,

    // Region picker query (provider-agnostic; PHALA returns sentinel).
    ...regionsQueries,

    // GitHub-source deploy queries
    ...githubQueries,

    // Service container logs
    ...logsQueries,

    // Live container health
    ...healthQueries,

    // Service connectivity (env vars, ports, links)
    ...serviceConnectivityQueries,

    // Org billing runway
    orgBillingRunway: async (_: unknown, __: unknown, context: Context) => {
      requireAuth(context)
      if (!context.organizationId) return null

      try {
        const billingClient = getBillingApiClient()
        const orgBilling = await billingClient.getOrgBilling(context.organizationId)
        const balance = await billingClient.getOrgBalance(orgBilling.orgBillingId)
        const totalHourlyBurnCents = await getOrgHourlyBurnCents(context.prisma, orgBilling.orgBillingId)

        let runwayHours: number | null = null
        let runwayFormatted = 'No active deployments'

        if (totalHourlyBurnCents > 0) {
          runwayHours = balance.balanceCents / totalHourlyBurnCents
          if (runwayHours > 24 * 30) {
            runwayFormatted = `~${Math.floor(runwayHours / 24)} days`
          } else if (runwayHours > 24) {
            const days = Math.floor(runwayHours / 24)
            const hrs = Math.floor(runwayHours % 24)
            runwayFormatted = hrs > 0 ? `~${days}d ${hrs}h` : `~${days} days`
          } else if (runwayHours > 1) {
            runwayFormatted = `~${Math.floor(runwayHours)}h`
          } else if (runwayHours > 0) {
            runwayFormatted = `< 1h`
          } else {
            runwayFormatted = 'Insufficient funds'
          }
        }

        return {
          balanceCents: balance.balanceCents,
          totalDailyBurnCents: Math.round(totalHourlyBurnCents * 24),
          runwayHours,
          runwayFormatted,
        }
      } catch {
        return null
      }
    },

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

    updateProject: async (
      _: unknown,
      { id, data }: { id: string; data: { name?: string } },
      context: Context
    ) => {
      requireAuth(context)

      const project = await context.prisma.project.findUnique({
        where: { id },
        select: { id: true, userId: true, organizationId: true },
      })

      if (!project) {
        throw new GraphQLError('Project not found')
      }

      assertProjectAccess(context, project, 'Not authorized to update this project')

      const updateData: Record<string, unknown> = {}
      if (data.name !== undefined && data.name !== null) {
        updateData.name = data.name
        updateData.slug = generateSlug(data.name)
      }

      if (Object.keys(updateData).length === 0) {
        return context.prisma.project.findUnique({ where: { id } })
      }

      return context.prisma.project.update({
        where: { id },
        data: updateData,
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

      assertProjectAccess(context, project, 'Not authorized to delete this project')

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
      const targetProjectId = await requireOwnedProjectContext(context)

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
      requireAuth(context)

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
          project: { select: { userId: true, organizationId: true } },
        },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      assertProjectAccess(context, (site as any).project, 'Not authorized to delete this site')

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
      requireAuth(context)

      const site = await context.prisma.site.findUnique({
        where: { id: data.siteId },
        include: { project: { select: { userId: true, organizationId: true } } },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      const p = (site as any).project
      if (p) assertProjectAccess(context, p, 'Not authorized to deploy to this site')

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
      if (!context.userId) {
        throw new GraphQLError('Not authenticated')
      }

      const site = await context.prisma.site.findUnique({
        where: { id: siteId },
        include: { project: { select: { userId: true, organizationId: true } } },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      const p = (site as any).project
      if (p) assertProjectAccess(context, p, 'Not authorized to deploy to this site')

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
    createService: async (
      _: unknown,
      {
        input,
      }: { input: { name: string; projectId: string; type?: string; templateId?: string; flavor?: string | null; dockerImage?: string; containerPort?: number } },
      context: Context
    ) => {
      requireAuth(context)

      const project = await context.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, slug: true, userId: true, organizationId: true },
      })
      if (!project) throw new GraphQLError('Project not found')
      assertProjectAccess(context, project, 'Not authorized to create a service in this project')

      const slug = generateSlug(input.name)
      const serviceType = (input.type as any) || 'FUNCTION'

      // Validate the catalog-flow discriminator. Templates always resolve
      // to 'template' regardless of what the caller sent (so the UI
      // can't mis-tag a template-backed service). Anything else must be one
      // of the known flavors or null (legacy/unspecified — readers default
      // to 'docker' for VM, 'function' for FUNCTION).
      const ALLOWED_FLAVORS = new Set(['docker', 'server', 'function', 'template', 'github'])
      let flavor: string | null = null
      if (input.templateId) {
        flavor = 'template'
      } else if (input.flavor != null) {
        if (!ALLOWED_FLAVORS.has(input.flavor)) {
          throw new GraphQLError(
            `Invalid flavor "${input.flavor}". Must be one of: docker, server, function, template, github.`
          )
        }
        flavor = input.flavor
      }

      // When a templateId is supplied, resolve the template and run the
      // same env-var seeding that `deployFromTemplate` does. Without
      // this, the catalog flow (AddServiceBox -> createServiceEntry -> here)
      // creates a stub Service with ZERO ServiceEnvVar rows, which means
      // platform-injected creds (`generatedAccessKey` / `generatedSecret`)
      // never get generated. The user lands on the workspace, deploys, and
      // the SDL is emitted with no credentials → the running container
      // falls back to upstream defaults (e.g. RustFS uses `rustfsadmin`).
      // Bug surfaced via the bucket-as-first-class-service refactor:
      // RustFS console showed empty access/secret keys after deploy.
      const template = input.templateId ? getTemplateById(input.templateId) : null
      if (input.templateId && !template) {
        throw new GraphQLError(`Template not found: ${input.templateId}`, {
          extensions: { code: 'NOT_FOUND' },
        })
      }

      // Resolve env overrides up-front so injectPlatformEnvVars can fail fast
      // (e.g. service-auth down) BEFORE we create any DB rows.
      const envOverrides: Record<string, string> = {}
      if (template) {
        await injectPlatformEnvVars(template, envOverrides, context, slug)
      }

      const service = await context.prisma.service.create({
        data: {
          // When a template is in play, force the service type to match the
          // template's declared serviceType. The web client should already
          // be sending the right value, but defending here means a
          // mistyped client never desynchronises the registry from the
          // template's intended deployment shape.
          type: template?.serviceType ?? serviceType,
          name: input.name,
          slug,
          projectId: input.projectId,
          templateId: input.templateId ?? null,
          flavor,
          dockerImage: input.dockerImage ?? null,
          containerPort: input.containerPort ?? null,
          createdByUserId: context.userId ?? null,
          internalHostname: generateInternalHostname(slug, project.slug),
        },
      })

      if (template) {
        // Persist a ServiceEnvVar row per template envVar so the deploy view
        // shows real values (including generated creds), the user can edit
        // them, and `injectPersistedEnvVars` in the orchestrator picks them
        // up at SDL generation time.
        if (template.envVars?.length) {
          await context.prisma.$transaction(
            template.envVars.map((ev) =>
              context.prisma.serviceEnvVar.create({
                data: {
                  serviceId: service.id,
                  key: ev.key,
                  value: envOverrides[ev.key] ?? ev.default ?? '',
                  secret: ev.secret ?? false,
                },
              })
            )
          )
        }
        // Persist ports the same way deployFromTemplate does. Idempotent
        // for the workspace's port editor; deploy-time SDL generation also
        // reads from the template, so this is mainly for UI surfacing.
        if (template.ports?.length) {
          await context.prisma.$transaction(
            template.ports.map((p) =>
              context.prisma.servicePort.create({
                data: {
                  serviceId: service.id,
                  containerPort: p.port,
                  publicPort: p.global ? p.as : null,
                  protocol: 'TCP',
                },
              })
            )
          )
        }
      }

      return service
    },

    updateServicePriority: async (
      _: unknown,
      { serviceId, shutdownPriority }: { serviceId: string; shutdownPriority: number },
      context: Context
    ) => {
      requireAuth(context)

      const service = await context.prisma.service.findUnique({
        where: { id: serviceId },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!service) throw new GraphQLError('Service not found')
      assertProjectAccess(context, service.project, 'Not authorized to update this service')

      const clamped = Math.max(0, Math.min(100, shutdownPriority))
      return context.prisma.service.update({
        where: { id: serviceId },
        data: { shutdownPriority: clamped },
      })
    },

    /**
     * updateService — patch the source-of-truth fields on a Service registry
     * entry (currently `dockerImage` and `containerPort`). Powers the Source
     * tab in the web app for VM/raw services. See typeDefs comment for full
     * semantics. New backend mutation introduced for the Docker source UX
     * work — there was previously no way to edit these fields after creation.
     */
    updateService: async (
      _: unknown,
      {
        serviceId,
        input,
      }: {
        serviceId: string
        input: {
          dockerImage?: string | null
          containerPort?: number | null
          volumes?: Array<{ name: string; mountPath: string; size: string }> | null
          healthProbe?: {
            path: string
            port?: number | null
            expectStatus?: number
            intervalSec?: number
            timeoutSec?: number
          } | null
          failoverPolicy?: {
            enabled: boolean
            maxAttempts?: number
            windowHours?: number
          } | null
        }
      },
      context: Context
    ) => {
      requireAuth(context)

      const service = await context.prisma.service.findUnique({
        where: { id: serviceId },
        include: {
          project: { select: { userId: true, organizationId: true } },
          akashDeployments: { select: { status: true } },
        },
      })
      if (!service) throw new GraphQLError('Service not found')
      assertProjectAccess(context, service.project, 'Not authorized to update this service')

      // Block edits while any deployment is mid-flight on Akash. ACTIVE/FAILED/
      // CLOSED/SUSPENDED/PERMANENTLY_FAILED are fine — the change applies on
      // the next redeploy. Mirrors how Railway queues source changes.
      // Pending status set lives on AKASH_DESCRIPTOR.
      const blockingDeployment = service.akashDeployments.find(d =>
        AKASH_PENDING_STATUSES.includes(d.status as unknown as string)
      )
      if (blockingDeployment) {
        throw new GraphQLError(
          `Cannot update service while a deployment is in progress (status: ${blockingDeployment.status}). Wait for it to reach ACTIVE or FAILED, then try again.`
        )
      }

      // Prisma JSON columns require either an InputJsonValue or `JsonNull`.
      // We use `any` for the volumes entry to avoid pulling Prisma types into
      // this file purely for one optional field; runtime validation below is
      // strict.
      const data: {
        dockerImage?: string | null
        containerPort?: number | null
        volumes?: any
        healthProbe?: any
        failoverPolicy?: any
      } = {}

      if (Object.prototype.hasOwnProperty.call(input, 'dockerImage')) {
        const raw = input.dockerImage
        if (raw === null || raw === '') {
          data.dockerImage = null
        } else if (typeof raw === 'string') {
          const trimmed = raw.trim()
          // Permissive Docker image reference: registry/owner/name:tag or
          // name@sha256:digest. Allow common chars; reject obvious junk.
          if (!/^[a-zA-Z0-9._\-/:@]+$/.test(trimmed)) {
            throw new GraphQLError(
              'Invalid Docker image reference. Expected something like "ghcr.io/owner/repo:v1" or "nginx:1.25-alpine".'
            )
          }
          // Akash providers cache by tag — `:latest` and `:main` will not
          // re-pull on redeploy. See .cursor/rules/akash-sdl.mdc.
          const tagMatch = trimmed.match(/:([^/@]+)$/)
          const tag = tagMatch?.[1]
          if (tag === 'latest' || tag === 'main') {
            throw new GraphQLError(
              `Tag "${tag}" cannot be used on Akash — providers cache by tag and won't re-pull. Use a versioned tag (e.g. ":v1", ":v2") or a digest.`
            )
          }
          data.dockerImage = trimmed
        }
      }

      if (Object.prototype.hasOwnProperty.call(input, 'containerPort')) {
        const port = input.containerPort
        if (port === null) {
          data.containerPort = null
        } else if (typeof port === 'number') {
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new GraphQLError('containerPort must be an integer between 1 and 65535.')
          }
          data.containerPort = port
        }
      }

      // Volumes — persistent storage attached to raw Docker images.
      // Templates own their volume layout via template.persistentStorage and
      // ignore this field. We validate strictly here to keep the SDL builder
      // simple downstream.
      if (Object.prototype.hasOwnProperty.call(input, 'volumes')) {
        const v = input.volumes
        if (v === null) {
          data.volumes = null
        } else if (Array.isArray(v)) {
          if (v.length > 4) {
            throw new GraphQLError('At most 4 volumes are allowed per service.')
          }
          const seenNames = new Set<string>()
          const seenMounts = new Set<string>()
          const cleaned = v.map((vol, idx) => {
            if (!vol || typeof vol !== 'object') {
              throw new GraphQLError(`volumes[${idx}] must be an object with name, mountPath, and size.`)
            }
            const name = String((vol as any).name ?? '').trim()
            const mountPath = String((vol as any).mountPath ?? '').trim()
            const size = String((vol as any).size ?? '').trim()
            if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
              throw new GraphQLError(
                `volumes[${idx}].name must be lowercase letters/digits/hyphens, start with a letter, max 31 chars.`
              )
            }
            if (seenNames.has(name)) {
              throw new GraphQLError(`Duplicate volume name "${name}". Names must be unique within a service.`)
            }
            seenNames.add(name)
            if (!mountPath.startsWith('/') || mountPath.length > 4096 || /\/$/.test(mountPath)) {
              throw new GraphQLError(
                `volumes[${idx}].mountPath must be an absolute path without a trailing slash (e.g. "/data").`
              )
            }
            if (seenMounts.has(mountPath)) {
              throw new GraphQLError(`Duplicate mountPath "${mountPath}". Each volume must mount to a distinct path.`)
            }
            seenMounts.add(mountPath)
            if (!/^\d+(Mi|Gi|Ti)$/.test(size)) {
              throw new GraphQLError(
                `volumes[${idx}].size must be a number followed by Mi, Gi, or Ti (e.g. "5Gi", "100Mi").`
              )
            }
            return { name, mountPath, size }
          })
          data.volumes = cleaned
        } else {
          throw new GraphQLError('volumes must be an array of { name, mountPath, size } objects, or null to clear.')
        }
      }

      // Health probe — application-level HTTP probe configured per service.
      // Defaults applied at runtime by `ApplicationHealthRunner`, so
      // here we only validate field shape + ranges and refuse anything weird.
      if (Object.prototype.hasOwnProperty.call(input, 'healthProbe')) {
        const probe = input.healthProbe
        if (probe === null) {
          data.healthProbe = null
        } else if (typeof probe === 'object') {
          const path = typeof probe.path === 'string' ? probe.path.trim() : ''
          if (!path.startsWith('/')) {
            throw new GraphQLError('healthProbe.path must start with "/" (e.g. "/health").')
          }
          if (path.length > 2048) {
            throw new GraphQLError('healthProbe.path is too long (max 2048 chars).')
          }
          const cleaned: Record<string, unknown> = { path }
          if (probe.port !== undefined && probe.port !== null) {
            const port = Number(probe.port)
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              throw new GraphQLError('healthProbe.port must be an integer between 1 and 65535.')
            }
            cleaned.port = port
          }
          if (probe.expectStatus !== undefined) {
            const status = Number(probe.expectStatus)
            if (!Number.isInteger(status) || status < 100 || status > 599) {
              throw new GraphQLError('healthProbe.expectStatus must be an HTTP status code between 100 and 599.')
            }
            cleaned.expectStatus = status
          }
          if (probe.intervalSec !== undefined) {
            const n = Number(probe.intervalSec)
            if (!Number.isInteger(n) || n < 10 || n > 3600) {
              throw new GraphQLError('healthProbe.intervalSec must be an integer between 10 and 3600 seconds.')
            }
            cleaned.intervalSec = n
          }
          if (probe.timeoutSec !== undefined) {
            const n = Number(probe.timeoutSec)
            if (!Number.isInteger(n) || n < 1 || n > 30) {
              throw new GraphQLError('healthProbe.timeoutSec must be an integer between 1 and 30 seconds.')
            }
            cleaned.timeoutSec = n
          }
          data.healthProbe = cleaned
        } else {
          throw new GraphQLError('healthProbe must be an object with at least { path }, or null to clear.')
        }
      }

      // Failover policy — health-aware auto-redeploy on dead providers.
      // We refuse the combination "failover enabled + service has
      // volumes" because failover spawns a fresh deployment on a different
      // provider with no carry-over of /data. The user must either remove
      // volumes first or accept that auto-failover is off for stateful apps.
      if (Object.prototype.hasOwnProperty.call(input, 'failoverPolicy')) {
        const policy = input.failoverPolicy
        if (policy === null) {
          data.failoverPolicy = null
        } else if (typeof policy === 'object') {
          if (typeof policy.enabled !== 'boolean') {
            throw new GraphQLError('failoverPolicy.enabled is required and must be a boolean.')
          }
          const cleaned: Record<string, unknown> = { enabled: policy.enabled }
          if (policy.maxAttempts !== undefined) {
            const n = Number(policy.maxAttempts)
            if (!Number.isInteger(n) || n < 1 || n > 10) {
              throw new GraphQLError('failoverPolicy.maxAttempts must be an integer between 1 and 10.')
            }
            cleaned.maxAttempts = n
          }
          if (policy.windowHours !== undefined) {
            const n = Number(policy.windowHours)
            if (!Number.isInteger(n) || n < 1 || n > 720) {
              throw new GraphQLError('failoverPolicy.windowHours must be an integer between 1 and 720 hours.')
            }
            cleaned.windowHours = n
          }
          if (cleaned.enabled) {
            // Use whatever we're about to write; fall back to current row.
            const incomingVolumes =
              data.volumes !== undefined ? data.volumes : (service as any).volumes
            const volumeCount = Array.isArray(incomingVolumes) ? incomingVolumes.length : 0
            if (volumeCount > 0) {
              throw new GraphQLError(
                'Auto-failover cannot be enabled on a service that has persistent volumes — failover spawns a fresh deployment on a different provider and would lose the volume data. Remove volumes first or keep failover disabled.'
              )
            }
          }
          data.failoverPolicy = cleaned
        } else {
          throw new GraphQLError('failoverPolicy must be an object with at least { enabled }, or null to clear.')
        }
      }

      if (Object.keys(data).length === 0) {
        // Nothing to change — return the existing service rather than firing
        // an empty UPDATE.
        return service
      }

      return context.prisma.service.update({
        where: { id: serviceId },
        data,
      })
    },

    createAFFunction: async (
      _: unknown,
      {
        data,
      }: { data: { name?: string; siteId?: string; slug?: string; sourceCode?: string; routes?: any; status?: string } },
      context: Context
    ) => {
      await requireOwnedProjectContext(context)

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
            // Function services are always 'function' flavor; this is the
            // only catalog flow that produces them, so we hardcode
            // rather than accepting it from the caller.
            flavor: 'function',
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
      requireAuth(context)
      const func = await context.prisma.aFFunction.findUnique({
        where: { id: where.functionId },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!func) throw new GraphQLError('Function not found')
      assertProjectAccess(context, (func as any).project)

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
      requireAuth(context)
      const existing = await context.prisma.aFFunction.findUnique({
        where: { id: where.id },
        include: { project: { select: { userId: true, organizationId: true } } },
      })
      if (!existing) throw new GraphQLError('Function not found')
      assertProjectAccess(context, (existing as any).project)

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
      requireAuth(context)

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
          project: { select: { userId: true, organizationId: true } },
        },
      })

      if (!func) {
        throw new GraphQLError('Function not found')
      }

      assertProjectAccess(context, (func as any).project, 'Not authorized to delete this function')

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
      requireAuth(context)

      const service = await context.prisma.service.findUnique({
        where: { id },
        include: {
          project: { select: { userId: true, organizationId: true } },
        },
      })

      if (!service) {
        throw new GraphQLError('Service not found')
      }

      assertProjectAccess(context, (service as any).project, 'Not authorized to delete this service')

      // Guard: block deletion if any provider has a non-terminal deployment.
      // Each provider's descriptor.terminalStatuses defines what counts as
      // "done"; everything else blocks delete and the user must close
      // first.
      const nonTerminal = await findAllNonTerminalDeploymentsForService(
        context.prisma,
        id,
      )
      if (nonTerminal.length > 0) {
        const dep = nonTerminal[0]
        throw new GraphQLError(
          `Cannot delete "${service.name}" — it has an active ${dep.provider.displayName} deployment (${dep.deployment.status}). Close the deployment first.`
        )
      }

      // Best-effort: close orphaned deployments before destroying the
      // service row. Each provider's `close()` is idempotent (no-op when
      // already terminal) and handles its own quirks (Akash on-chain
      // close, Phala CVM delete, Spheron 20-min minimum-runtime defer).
      // The descriptor.needsCleanupStatuses set determines which rows
      // get cleaned — adding a new provider only requires populating
      // that field on its descriptor.
      for (const provider of getAllProviders()) {
        const { descriptor } = provider
        if (descriptor.needsCleanupStatuses.length === 0) continue
        const model = (context.prisma as unknown as Record<string, {
          findMany: (args: unknown) => Promise<Array<{ id: string }>>
        }>)[descriptor.prismaModel]
        const orphans = await model.findMany({
          where: { serviceId: id, status: { in: descriptor.needsCleanupStatuses } },
          select: { id: true },
        })
        for (const orphan of orphans) {
          try {
            await provider.close(orphan.id)
          } catch (err) {
            // Non-fatal — the upstream resource may already be gone,
            // or the provider has a deferred cleanup path (e.g. Spheron
            // 20-min floor → sweeper retries).
            console.warn(
              `[deleteService] best-effort cleanup failed for ${provider.name} deployment ${orphan.id}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        }
      }

      await context.prisma.service.delete({ where: { id } })
      return service
    },

    // Domains (from domain resolvers)
    ...domainMutations,

    // DNS Admin (from dnsAdmin resolvers)
    ...dnsAdminMutations,

    // Domain Registration / Purchase
    ...domainRegistrationMutations,

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

    // Spheron deployment mutations
    ...spheronMutations,

    // GitHub-source deploy mutations
    ...githubMutations,

    // Service connectivity mutations (env vars, ports, links)
    ...serviceConnectivityMutations,

    // Feedback mutations
    ...feedbackMutations,

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

  // The `Deployment` union lets a service expose its live deployment without
  // the consumer branching on provider. `__resolveType` discriminates by
  // Prisma row shape: `dseq` is unique to Akash, `appId` to Phala, and
  // `offerId` / `providerDeploymentId` to Spheron. New providers extend the
  // union with a new shape check here plus a new variant in the typeDefs
  // union.
  Deployment: {
    __resolveType: (obj: Record<string, unknown>) => {
      if (obj == null) return null
      if (obj.dseq != null) return 'AkashDeployment'
      if (obj.appId != null) return 'PhalaDeployment'
      if (obj.offerId != null || obj.providerDeploymentId != null) {
        return 'SpheronDeployment'
      }
      return null
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
    /**
     * activeDeployment — provider-agnostic accessor for the live
     * deployment. Returns the first non-terminal deployment across the
     * provider registry (companion services resolve via parentServiceId,
     * matching the legacy `activeXDeployment` fields).
     */
    activeDeployment: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      const found = await findActiveOrPendingDeploymentForService(
        context.prisma,
        serviceId,
      )
      if (!found) return null
      // Akash rows carry BigInt `dseq` / `depositUakt` which would
      // serialise as objects in GraphQL — mirror the per-provider
      // formatter the legacy `activeAkashDeployment` resolver uses.
      const dep = found.deployment as Record<string, unknown>
      if (found.provider.name === 'akash') {
        return {
          ...dep,
          dseq: (dep.dseq as { toString(): string }).toString(),
          depositUakt:
            dep.depositUakt != null
              ? (dep.depositUakt as { toString(): string }).toString()
              : null,
        }
      }
      return dep
    },
    /**
     * applicationHealth — live read from the in-memory ring buffer maintained
     * by `ApplicationHealthRunner`. Returns null when no probe is configured
     * or the runner hasn't observed this service yet (the dashboard renders
     * a grey "no data" badge in that case).
     */
    applicationHealth: async (parent: any) => {
      if (!parent?.id || !parent?.healthProbe) return null
      const { getApplicationHealthRunner } = await import('../services/health/applicationHealthRunner.js')
      const runner = getApplicationHealthRunner()
      const snap = runner.getSnapshot(parent.id)
      if (!snap) return null
      const last = snap.results[snap.results.length - 1]
      return {
        overall: runner.getOverall(parent.id),
        lastChecked: snap.lastChecked,
        lastStatus: last?.statusCode ?? null,
        lastError: last?.error ?? null,
        recentResults: snap.results,
      }
    },
    /**
     * failoverHistory — derived view over the failover chain for this
     * service. Returns null when no failover has fired (the chain is empty).
     * The `chain` array is newest-first and includes the original deployment
     * + every spawned replacement so the UI can show the full lineage.
     */
    failoverHistory: async (parent: any, _: unknown, context: Context) => {
      if (!parent?.id) return null
      const { parseFailoverPolicy, countAttemptsInWindow } = await import(
        '../services/failover/failoverService.js'
      )
      const policy = parseFailoverPolicy(parent.failoverPolicy)
      const failovers = await context.prisma.akashDeployment.findMany({
        where: {
          serviceId: parent.id,
          failoverParentId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          parentDeploymentId: true,
          failoverParentId: true,
          provider: true,
          excludedProviders: true,
          status: true,
          failoverReason: true,
          createdAt: true,
          deployedAt: true,
          closedAt: true,
        },
      })
      if (failovers.length === 0) return null
      const attemptsInWindow = await countAttemptsInWindow(
        context.prisma,
        parent.id,
        policy.windowHours
      )
      return {
        attemptsInWindow,
        maxAttempts: policy.maxAttempts,
        windowHours: policy.windowHours,
        chain: failovers.map(f => ({
          deploymentId: f.id,
          parentDeploymentId: f.failoverParentId,
          provider: f.provider,
          excludedProviders: f.excludedProviders ?? [],
          status: f.status,
          reason: f.failoverReason,
          createdAt: f.createdAt,
          deployedAt: f.deployedAt,
          closedAt: f.closedAt,
        })),
      }
    },
    // Merge Akash-related Service field resolvers (akashDeployments, activeAkashDeployment)
    ...(akashFieldResolvers.Service ?? {}),
    // Merge Phala-related Service field resolvers (phalaDeployments, activePhalaDeployment)
    ...(phalaFieldResolvers.Service ?? {}),
    // Merge Spheron-related Service field resolvers (spheronDeployments, activeSpheronDeployment)
    ...(spheronFieldResolvers.Service ?? {}),
    // Merge inter-service communication field resolvers (envVars, ports, linksFrom, linksTo)
    ...(serviceConnectivityFieldResolvers.Service ?? {}),
    // Merge GitHub-source field resolvers (latestBuild, buildJobs)
    ...(githubFieldResolvers.Service ?? {}),
  },

  ServiceLink: {
    ...(serviceConnectivityFieldResolvers.ServiceLink ?? {}),
  },

  GithubInstallation: {
    ...(githubFieldResolvers.GithubInstallation ?? {}),
  },

  Site: {
    service: (parent: any, _: unknown, context: Context) => {
      if (!parent.serviceId) return null
      return context.prisma.service.findUnique({
        where: { id: parent.serviceId },
      })
    },
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
    site: async (parent: any, _: unknown, context: Context) => {
      if (!parent.siteId) return null
      if (parent.site) return parent.site
      return context.prisma.site.findUnique({ where: { id: parent.siteId } })
    },
    zone: async (parent: any, _: unknown, context: Context) => {
      if (!parent.siteId) return null
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
    service: (parent: any, _: unknown, context: Context) => {
      if (!parent.serviceId) return null
      return context.prisma.service.findUnique({
        where: { id: parent.serviceId },
      })
    },
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

  // Template component field resolvers
  ...templateFieldResolvers,

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

  // Spheron deployment field resolvers
  SpheronDeployment: spheronFieldResolvers.SpheronDeployment,

  // Subscriptions for real-time updates
  Subscription: {
    // GraphQL subscription operations
    deploymentLogs: {
      subscribe: async function* (
        _: unknown,
        { deploymentId }: { deploymentId: string },
        context: Context
      ) {
        requireAuth(context)

        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
          include: { site: { include: { project: { select: { userId: true, organizationId: true } } } } },
        })

        if (!deployment) {
          subscriptionHealthMonitor.trackError(
            'Deployment not found',
            deploymentId
          )
          throw new GraphQLError('Deployment not found')
        }

        if ((deployment as any).site?.project) {
          assertProjectAccess(context, (deployment as any).site.project)
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
        requireAuth(context)

        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
          include: { site: { include: { project: { select: { userId: true, organizationId: true } } } } },
        })

        if (!deployment) {
          subscriptionHealthMonitor.trackError(
            'Deployment not found',
            deploymentId
          )
          throw new GraphQLError('Deployment not found')
        }

        if ((deployment as any).site?.project) {
          assertProjectAccess(context, (deployment as any).site.project)
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
