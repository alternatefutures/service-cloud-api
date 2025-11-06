import { GraphQLError } from 'graphql';
import type { PrismaClient } from '@prisma/client';
import { generateSlug } from '../utils/slug.js';
import { generateInvokeUrl } from '../utils/invokeUrl.js';
import { validateRoutes } from '../utils/routeValidation.js';
import { DeploymentService } from '../services/deployment/index.js';
import type { StorageType } from '../services/storage/factory.js';
import { deploymentEvents } from '../services/events/index.js';
import { subscriptionHealthMonitor } from '../services/monitoring/subscriptionHealthCheck.js';
import { chatResolvers } from './chat.js';
import { billingResolvers } from './billing.js';
import { domainQueries, domainMutations } from './domain.js';
import type { Context } from './types.js';

export type { Context };

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
    afFunctionByName: async (_: unknown, { name }: { name: string }, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }

      const func = await context.prisma.aFFunction.findFirst({
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

    afFunctions: async (_: unknown, __: unknown, context: Context) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }
      return context.prisma.aFFunction.findMany({
        where: { projectId: context.projectId },
      });
    },

    afFunctionDeployments: async (
      _: unknown,
      { functionId }: { functionId: string },
      context: Context
    ) => {
      return context.prisma.aFFunctionDeployment.findMany({
        where: { afFunctionId: functionId },
        orderBy: { createdAt: 'desc' },
      });
    },

    // Domains (from domain resolvers)
    ...domainQueries,

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

    // System Health
    subscriptionHealth: () => {
      return subscriptionHealthMonitor.performHealthCheck();
    },

    // Chat queries (from chat resolvers)
    ...chatResolvers.Query,

    // Billing queries (from billing resolvers)
    ...billingResolvers.Query,
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

    // Deployments
    createDeployment: async (
      _: unknown,
      {
        siteId,
        sourceDirectory,
        storageType = 'IPFS',
        buildOptions,
      }: {
        siteId: string;
        sourceDirectory: string;
        storageType?: StorageType;
        buildOptions?: {
          buildCommand: string;
          installCommand?: string;
          workingDirectory?: string;
          outputDirectory?: string;
        };
      },
      context: Context
    ) => {
      // Verify site exists
      const site = await context.prisma.site.findUnique({
        where: { id: siteId },
      });

      if (!site) {
        throw new GraphQLError('Site not found');
      }

      const deploymentService = new DeploymentService(context.prisma);

      const result = await deploymentService.deploy({
        siteId,
        sourceDirectory,
        storageType,
        buildOptions,
        outputDirectory: buildOptions?.outputDirectory,
      });

      // Return the created deployment
      const deployment = await context.prisma.deployment.findUnique({
        where: { id: result.deploymentId },
      });

      if (!deployment) {
        throw new GraphQLError('Deployment not found after creation');
      }

      return deployment;
    },

    // Functions
    createAFFunction: async (
      _: unknown,
      { name, siteId, routes }: { name: string; siteId?: string; routes?: any },
      context: Context
    ) => {
      if (!context.projectId) {
        throw new GraphQLError('Project ID required');
      }

      // Validate routes if provided
      if (routes) {
        validateRoutes(routes);
      }

      const slug = generateSlug(name);
      const invokeUrl = generateInvokeUrl(slug);

      return context.prisma.aFFunction.create({
        data: {
          name,
          slug,
          invokeUrl,
          projectId: context.projectId,
          siteId,
          routes: routes || undefined,
          status: 'ACTIVE',
        },
      });
    },

    deployAFFunction: async (
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
      const deployment = await context.prisma.aFFunctionDeployment.create({
        data: {
          cid,
          sgx,
          blake3Hash,
          assetsCid,
          afFunctionId: functionId,
        },
      });

      // Update function's current deployment
      await context.prisma.aFFunction.update({
        where: { id: functionId },
        data: {
          currentDeploymentId: deployment.id,
          status: 'ACTIVE',
        },
      });

      return deployment;
    },

    updateAFFunction: async (
      _: unknown,
      { id, name, slug, routes, status }: { id: string; name?: string; slug?: string; routes?: any; status?: string },
      context: Context
    ) => {
      // Validate routes if provided
      if (routes !== undefined && routes !== null) {
        validateRoutes(routes);
      }

      return context.prisma.aFFunction.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(slug && { slug }),
          ...(routes !== undefined && { routes }),
          ...(status && { status: status as any }),
        },
      });
    },

    deleteAFFunction: async (_: unknown, { id }: { id: string }, context: Context) => {
      await context.prisma.aFFunction.delete({
        where: { id },
      });
      return true;
    },

    // Domains (from domain resolvers)
    ...domainMutations,

    // Chat mutations (from chat resolvers)
    ...chatResolvers.Mutation,

    // Billing mutations (from billing resolvers)
    ...billingResolvers.Mutation,
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
      return context.prisma.aFFunction.findMany({
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

  AFFunction: {
    project: (parent: any, _: unknown, context: Context) => {
      return context.prisma.project.findUnique({
        where: { id: parent.projectId },
      });
    },
    currentDeployment: (parent: any, _: unknown, context: Context) => {
      if (!parent.currentDeploymentId) return null;
      return context.prisma.aFFunctionDeployment.findUnique({
        where: { id: parent.currentDeploymentId },
      });
    },
    deployments: (parent: any, _: unknown, context: Context) => {
      return context.prisma.aFFunctionDeployment.findMany({
        where: { afFunctionId: parent.id },
        orderBy: { createdAt: 'desc' },
      });
    },
  },

  AFFunctionDeployment: {
    afFunction: (parent: any, _: unknown, context: Context) => {
      return context.prisma.aFFunction.findUnique({
        where: { id: parent.afFunctionId },
      });
    },
  },

  // Chat field resolvers
  Agent: chatResolvers.Agent,
  Chat: chatResolvers.Chat,
  Message: chatResolvers.Message,

  // Billing field resolvers
  Customer: billingResolvers.Customer,
  PaymentMethod: billingResolvers.PaymentMethod,
  Invoice: billingResolvers.Invoice,
  Payment: billingResolvers.Payment,
  UsageRecord: billingResolvers.UsageRecord,

  // Subscriptions for real-time updates
  Subscription: {
    // Billing subscription field resolvers
    ...billingResolvers.Subscription,
    // GraphQL subscription operations
    deploymentLogs: {
      subscribe: async function* (_: unknown, { deploymentId }: { deploymentId: string }, context: Context) {
        // Verify deployment exists
        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
        });

        if (!deployment) {
          subscriptionHealthMonitor.trackError('Deployment not found', deploymentId);
          throw new GraphQLError('Deployment not found');
        }

        // Track subscription creation
        subscriptionHealthMonitor.trackSubscriptionCreated(deploymentId);

        // Create an async generator that yields log events
        const queue: any[] = [];
        let resolve: ((value: IteratorResult<any>) => void) | null = null;

        const handler = (event: any) => {
          subscriptionHealthMonitor.trackEventEmitted();
          if (resolve) {
            resolve({ value: event, done: false });
            resolve = null;
          } else {
            queue.push(event);
          }
        };

        deploymentEvents.onLog(deploymentId, handler);

        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift();
            } else {
              await new Promise<void>((res) => {
                resolve = (result) => {
                  if (!result.done) {
                    res();
                  }
                };
              });

              if (queue.length > 0) {
                yield queue.shift();
              }
            }
          }
        } catch (error) {
          subscriptionHealthMonitor.trackError(
            error instanceof Error ? error.message : 'Unknown error',
            deploymentId
          );
          throw error;
        } finally {
          deploymentEvents.removeLogListener(deploymentId, handler);
          subscriptionHealthMonitor.trackSubscriptionClosed(deploymentId);
        }
      },
      resolve: (payload: any) => payload,
    },

    deploymentStatus: {
      subscribe: async function* (_: unknown, { deploymentId }: { deploymentId: string }, context: Context) {
        // Verify deployment exists
        const deployment = await context.prisma.deployment.findUnique({
          where: { id: deploymentId },
        });

        if (!deployment) {
          subscriptionHealthMonitor.trackError('Deployment not found', deploymentId);
          throw new GraphQLError('Deployment not found');
        }

        // Track subscription creation
        subscriptionHealthMonitor.trackSubscriptionCreated(deploymentId);

        // Create an async generator that yields status events
        const queue: any[] = [];
        let resolve: ((value: IteratorResult<any>) => void) | null = null;

        const handler = (event: any) => {
          subscriptionHealthMonitor.trackEventEmitted();
          if (resolve) {
            resolve({ value: event, done: false });
            resolve = null;
          } else {
            queue.push(event);
          }
        };

        deploymentEvents.onStatus(deploymentId, handler);

        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift();
            } else {
              await new Promise<void>((res) => {
                resolve = (result) => {
                  if (!result.done) {
                    res();
                  }
                };
              });

              if (queue.length > 0) {
                yield queue.shift();
              }
            }
          }
        } catch (error) {
          subscriptionHealthMonitor.trackError(
            error instanceof Error ? error.message : 'Unknown error',
            deploymentId
          );
          throw error;
        } finally {
          deploymentEvents.removeStatusListener(deploymentId, handler);
          subscriptionHealthMonitor.trackSubscriptionClosed(deploymentId);
        }
      },
      resolve: (payload: any) => payload,
    },
  },
};
