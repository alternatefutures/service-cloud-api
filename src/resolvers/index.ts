import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
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
import { StorageTracker } from '../services/billing/storageTracker.js'
import type { Context } from './types.js'

export type { Context }

// Service factory for storage tracking (billing is now handled by service-auth)
const storageTracker = (prisma: any) => new StorageTracker(prisma)

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

      return context.prisma.project.create({
        data: {
          name,
          slug,
          userId: context.userId,
          organizationId: context.organizationId,
        },
      })
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
        const service = await tx.service.create({
          data: {
            type: 'SITE',
            name: data.name,
            slug,
            projectId: targetProjectId,
            createdByUserId: context.userId ?? null,
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
      }: { data: { name?: string; siteId?: string; slug?: string; routes?: any; status?: string } },
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
        const service = await tx.service.create({
          data: {
            type: 'FUNCTION',
            name,
            slug,
            projectId: context.projectId!,
            createdByUserId: context.userId ?? null,
          },
        })

        return tx.aFFunction.create({
          data: {
            name,
            slug,
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
        data: { name?: string; slug?: string; siteId?: string; routes?: any; status?: string } | null
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
