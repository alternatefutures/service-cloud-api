import { GraphQLError } from 'graphql';
import type { YogaInitialContext } from 'graphql-yoga';
import type { PrismaClient } from '@prisma/client';
import { generateSlug } from '../utils/slug.js';
import { generateInvokeUrl } from '../utils/invokeUrl.js';

export interface Context extends YogaInitialContext {
  prisma: PrismaClient;
  userId?: string;
  projectId?: string;
}

export const resolvers = {
  Query: {
    version: () => ({
      commitHash: process.env.COMMIT_HASH || 'dev',
    }),

    me: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated');
      }
      return context.prisma.user.findUnique({
        where: { id: context.userId },
      });
    },

    // Projects
    project: async (_: unknown, { id }: { id: string }, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id },
      });
    },

    projects: async (_: unknown, __: unknown, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated');
      }
      return context.prisma.project.findMany({
        where: { userId: context.userId },
      });
    },

    // Sites
    site: async (_: unknown, { id }: { id: string }, context: Context) => {
      return context.prisma.site.findUnique({
        where: { id },
      });
    },

    sites: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }
      return context.prisma.site.findMany({
        where: { projectId: context.projectId },
      });
    },

    siteBySlug: async (_: unknown, { slug }: { slug: string }, context: Context) => {
      return context.prisma.site.findUnique({
        where: { slug },
      });
    },

    // Functions
    fleekFunctionByName: async (_: unknown, { name }: { name: string }, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }

      const func = await context.prisma.fleekFunction.findFirst({
        where: {
          name,
          projectId: context.projectId,
        },
      });

      if (!func) {
        throw new GraphQLError('Function not found');
      }

      return func;
    },

    fleekFunctions: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }
      return context.prisma.fleekFunction.findMany({
        where: { projectId: context.projectId },
      });
    },

    fleekFunctionDeployments: async (
      _: unknown,
      { functionId }: { functionId: string },
      context: Context
    ) => {
      return context.prisma.fleekFunctionDeployment.findMany({
        where: { fleekFunctionId: functionId },
        orderBy: { createdAt: 'desc' },
      });
    },

    // Domains
    domains: async (_: unknown, { siteId }: { siteId?: string }, context: Context) => {
      return context.prisma.domain.findMany({
        where: siteId ? { siteId } : undefined,
      });
    },

    // Storage Analytics
    storageAnalytics: async (
      _: unknown,
      { projectId }: { projectId?: string },
      context: Context
    ) => {
      const targetProjectId = projectId || context.projectId;
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required');
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
      });

      // Calculate totals
      let totalSize = 0;
      let ipfsSize = 0;
      let arweaveSize = 0;
      let deploymentCount = 0;

      const breakdown: any[] = [];

      for (const site of sites) {
        let siteSize = 0;
        let siteDeploymentCount = 0;
        let lastDeployment: Date | null = null;

        for (const deployment of site.deployments) {
          const size = deployment.pin?.size || 0;
          siteSize += size;
          totalSize += size;
          deploymentCount++;
          siteDeploymentCount++;

          if (deployment.storageType === 'IPFS') {
            ipfsSize += size;
          } else if (deployment.storageType === 'ARWEAVE') {
            arweaveSize += size;
          }

          if (!lastDeployment || deployment.createdAt > lastDeployment) {
            lastDeployment = deployment.createdAt;
          }
        }

        if (siteDeploymentCount > 0) {
          breakdown.push({
            id: site.id,
            name: site.name,
            type: 'SITE',
            size: siteSize,
            deploymentCount: siteDeploymentCount,
            storageType: site.deployments[site.deployments.length - 1]?.storageType || 'IPFS',
            lastDeployment,
          });
        }
      }

      return {
        totalSize,
        ipfsSize,
        arweaveSize,
        deploymentCount,
        siteCount: sites.length,
        breakdown,
      };
    },

    storageUsageTrend: async (
      _: unknown,
      { projectId, days = 30 }: { projectId?: string; days?: number },
      context: Context
    ) => {
      const targetProjectId = projectId || context.projectId;
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required');
      }

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

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
      });

      // Group by date
      const trendMap = new Map<string, { totalSize: number; deploymentCount: number }>();

      for (const site of sites) {
        for (const deployment of site.deployments) {
          const dateKey = deployment.createdAt.toISOString().split('T')[0];
          const existing = trendMap.get(dateKey) || { totalSize: 0, deploymentCount: 0 };
          const size = deployment.pin?.size || 0;

          trendMap.set(dateKey, {
            totalSize: existing.totalSize + size,
            deploymentCount: existing.deploymentCount + 1,
          });
        }
      }

      // Convert to array and calculate cumulative
      const trend: any[] = [];
      let cumulativeSize = 0;

      for (const [dateKey, data] of Array.from(trendMap.entries()).sort()) {
        cumulativeSize += data.totalSize;
        trend.push({
          date: new Date(dateKey),
          totalSize: cumulativeSize,
          deploymentCount: data.deploymentCount,
        });
      }

      return trend;
    },
  },

  Mutation: {
    // Projects
    createProject: async (_: unknown, { name }: { name: string }, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Not authenticated');
      }

      const slug = generateSlug(name);

      return context.prisma.project.create({
        data: {
          name,
          slug,
          userId: context.userId,
        },
      });
    },

    // Sites
    createSite: async (
      _: unknown,
      { name, projectId }: { name: string; projectId?: string },
      context: Context
    ) => {
      const targetProjectId = projectId || context.projectId;
      if (!targetProjectId) {
        throw new GraphQLError('Project ID required');
      }

      const slug = generateSlug(name);

      return context.prisma.site.create({
        data: {
          name,
          slug,
          projectId: targetProjectId,
        },
      });
    },

    // Functions
    createFleekFunction: async (
      _: unknown,
      { name, siteId }: { name: string; siteId?: string },
      context: Context
    ) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }

      const slug = generateSlug(name);
      const invokeUrl = generateInvokeUrl(slug);

      return context.prisma.fleekFunction.create({
        data: {
          name,
          slug,
          invokeUrl,
          projectId: context.projectId,
          siteId,
          status: 'ACTIVE',
        },
      });
    },

    deployFleekFunction: async (
      _: unknown,
      {
        functionId,
        cid,
        sgx = false,
        blake3Hash,
        assetsCid,
      }: {
        functionId: string;
        cid: string;
        sgx?: boolean;
        blake3Hash?: string;
        assetsCid?: string;
      },
      context: Context
    ) => {
      const deployment = await context.prisma.fleekFunctionDeployment.create({
        data: {
          cid,
          sgx,
          blake3Hash,
          assetsCid,
          fleekFunctionId: functionId,
        },
      });

      // Update function's current deployment
      await context.prisma.fleekFunction.update({
        where: { id: functionId },
        data: {
          currentDeploymentId: deployment.id,
          status: 'ACTIVE',
        },
      });

      return deployment;
    },

    updateFleekFunction: async (
      _: unknown,
      { id, name, slug, status }: { id: string; name?: string; slug?: string; status?: string },
      context: Context
    ) => {
      return context.prisma.fleekFunction.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(slug && { slug }),
          ...(status && { status: status as any }),
        },
      });
    },

    deleteFleekFunction: async (_: unknown, { id }: { id: string }, context: Context) => {
      await context.prisma.fleekFunction.delete({
        where: { id },
      });
      return true;
    },

    // Domains
    createDomain: async (
      _: unknown,
      { hostname, siteId }: { hostname: string; siteId: string },
      context: Context
    ) => {
      return context.prisma.domain.create({
        data: {
          hostname,
          siteId,
          verified: false,
        },
      });
    },
  },

  // Field resolvers
  User: {
    projects: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findMany({
        where: { userId: parent.id },
      });
    },
  },

  Project: {
    user: (parent: any, _: unknown, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      });
    },
    sites: (parent: any, _: unknown, context: Context) => {
      return context.prisma.site.findMany({
        where: { projectId: parent.id },
      });
    },
    functions: (parent: any, _: unknown, context: Context) => {
      return context.prisma.fleekFunction.findMany({
        where: { projectId: parent.id },
      });
    },
  },

  Site: {
    project: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id: parent.projectId },
      });
    },
    deployments: (parent: any, _: unknown, context: Context) => {
      return context.prisma.deployment.findMany({
        where: { siteId: parent.id },
      });
    },
    domains: (parent: any, _: unknown, context: Context) => {
      return context.prisma.domain.findMany({
        where: { siteId: parent.id },
      });
    },
  },

  FleekFunction: {
    project: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id: parent.projectId },
      });
    },
    currentDeployment: (parent: any, _: unknown, context: Context) => {
      if (!parent.currentDeploymentId) return null;
      return context.prisma.fleekFunctionDeployment.findUnique({
        where: { id: parent.currentDeploymentId },
      });
    },
    deployments: (parent: any, _: unknown, context: Context) => {
      return context.prisma.fleekFunctionDeployment.findMany({
        where: { fleekFunctionId: parent.id },
        orderBy: { createdAt: 'desc' },
      });
    },
  },

  FleekFunctionDeployment: {
    fleekFunction: (parent: any, _: unknown, context: Context) => {
      return context.prisma.fleekFunction.findUnique({
        where: { id: parent.fleekFunctionId },
      });
    },
  },
};
