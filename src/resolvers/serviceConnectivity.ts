import { GraphQLError } from 'graphql'
import type { Context } from './types.js'
import { getTemplateById } from '../templates/index.js'
import {
  resolveConnectionStrings,
  getConnectionStringsForTemplate,
} from '../utils/connectionStrings.js'

// ── Field Resolvers ──────────────────────────────────────────────────

export const serviceConnectivityFieldResolvers = {
  Service: {
    envVars: async (parent: any, _: unknown, context: Context) => {
      const vars = await context.prisma.serviceEnvVar.findMany({
        where: { serviceId: parent.id },
        orderBy: { key: 'asc' },
      })
      return vars.map((v: any) => ({
        ...v,
        value: v.secret ? '••••••••' : v.value,
      }))
    },
    ports: (parent: any, _: unknown, context: Context) => {
      return context.prisma.servicePort.findMany({
        where: { serviceId: parent.id },
        orderBy: { containerPort: 'asc' },
      })
    },
    linksFrom: (parent: any, _: unknown, context: Context) => {
      return context.prisma.serviceLink.findMany({
        where: { sourceServiceId: parent.id },
        include: { sourceService: true, targetService: true },
      })
    },
    linksTo: (parent: any, _: unknown, context: Context) => {
      return context.prisma.serviceLink.findMany({
        where: { targetServiceId: parent.id },
        include: { sourceService: true, targetService: true },
      })
    },
  },
  ServiceLink: {
    sourceService: (parent: any, _: unknown, context: Context) => {
      if (parent.sourceService) return parent.sourceService
      return context.prisma.service.findUnique({
        where: { id: parent.sourceServiceId },
      })
    },
    targetService: (parent: any, _: unknown, context: Context) => {
      if (parent.targetService) return parent.targetService
      return context.prisma.service.findUnique({
        where: { id: parent.targetServiceId },
      })
    },
  },
}

// ── Queries ──────────────────────────────────────────────────────────

export const serviceConnectivityQueries = {
  serviceLinks: async (
    _: unknown,
    { projectId }: { projectId: string },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const project = await context.prisma.project.findUnique({
      where: { id: projectId },
    })
    if (!project) throw new GraphQLError('Project not found')

    const services = await context.prisma.service.findMany({
      where: { projectId },
      select: { id: true },
    })
    const serviceIds = services.map((s: any) => s.id)

    return context.prisma.serviceLink.findMany({
      where: { sourceServiceId: { in: serviceIds } },
      include: { sourceService: true, targetService: true },
      orderBy: { createdAt: 'desc' },
    })
  },
}

// ── Mutations ────────────────────────────────────────────────────────

async function verifyServiceOwnership(
  prisma: any,
  serviceId: string,
  userId: string
): Promise<any> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { project: true },
  })
  if (!service) throw new GraphQLError('Service not found')
  if (service.project.userId !== userId) {
    throw new GraphQLError('Not authorized')
  }
  return service
}

export const serviceConnectivityMutations = {
  setServiceEnvVar: async (
    _: unknown,
    {
      serviceId,
      key,
      value,
      secret,
    }: { serviceId: string; key: string; value: string; secret?: boolean },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, serviceId, context.userId)

    const envVar = await context.prisma.serviceEnvVar.upsert({
      where: { serviceId_key: { serviceId, key } },
      create: { serviceId, key, value, secret: secret ?? false },
      update: { value, secret: secret ?? false },
    })
    return {
      ...envVar,
      value: envVar.secret ? '••••••••' : envVar.value,
    }
  },

  deleteServiceEnvVar: async (
    _: unknown,
    { serviceId, key }: { serviceId: string; key: string },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, serviceId, context.userId)

    await context.prisma.serviceEnvVar.delete({
      where: { serviceId_key: { serviceId, key } },
    })
    return true
  },

  bulkSetServiceEnvVars: async (
    _: unknown,
    {
      serviceId,
      vars,
    }: {
      serviceId: string
      vars: Array<{ key: string; value: string; secret?: boolean }>
    },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, serviceId, context.userId)

    const results = await context.prisma.$transaction(
      vars.map((v) =>
        context.prisma.serviceEnvVar.upsert({
          where: { serviceId_key: { serviceId, key: v.key } },
          create: {
            serviceId,
            key: v.key,
            value: v.value,
            secret: v.secret ?? false,
          },
          update: { value: v.value, secret: v.secret ?? false },
        })
      )
    )
    return results.map((r: any) => ({
      ...r,
      value: r.secret ? '••••••••' : r.value,
    }))
  },

  setServicePort: async (
    _: unknown,
    {
      serviceId,
      containerPort,
      publicPort,
      protocol,
    }: {
      serviceId: string
      containerPort: number
      publicPort?: number | null
      protocol?: string | null
    },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, serviceId, context.userId)

    return context.prisma.servicePort.upsert({
      where: { serviceId_containerPort: { serviceId, containerPort } },
      create: {
        serviceId,
        containerPort,
        publicPort: publicPort ?? null,
        protocol: protocol ?? 'TCP',
      },
      update: {
        publicPort: publicPort ?? null,
        protocol: protocol ?? 'TCP',
      },
    })
  },

  deleteServicePort: async (
    _: unknown,
    { serviceId, containerPort }: { serviceId: string; containerPort: number },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, serviceId, context.userId)

    await context.prisma.servicePort.delete({
      where: { serviceId_containerPort: { serviceId, containerPort } },
    })
    return true
  },

  linkServices: async (
    _: unknown,
    {
      sourceServiceId,
      targetServiceId,
      alias,
    }: { sourceServiceId: string; targetServiceId: string; alias?: string | null },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const source = await verifyServiceOwnership(
      context.prisma,
      sourceServiceId,
      context.userId
    )
    const target = await context.prisma.service.findUnique({
      where: { id: targetServiceId },
    })
    if (!target) throw new GraphQLError('Target service not found')
    if (source.projectId !== target.projectId) {
      throw new GraphQLError('Services must be in the same project')
    }
    if (sourceServiceId === targetServiceId) {
      throw new GraphQLError('Cannot link a service to itself')
    }

    const link = await context.prisma.serviceLink.create({
      data: {
        sourceServiceId,
        targetServiceId,
        alias: alias ?? null,
      },
      include: { sourceService: true, targetService: true },
    })

    // Auto-inject connection string env vars if the target is a database with a template
    if (target.templateId) {
      const template = getTemplateById(target.templateId)
      const connStrings = getConnectionStringsForTemplate(template)
      if (connStrings) {
        const targetEnvVars = await context.prisma.serviceEnvVar.findMany({
          where: { serviceId: targetServiceId },
        })
        const targetPorts = await context.prisma.servicePort.findMany({
          where: { serviceId: targetServiceId },
        })

        const resolved = resolveConnectionStrings(connStrings, {
          internalHostname: target.internalHostname,
          slug: target.slug,
          ports: targetPorts.map((p: any) => ({
            containerPort: p.containerPort,
            publicPort: p.publicPort,
          })),
          envVars: targetEnvVars.map((e: any) => ({
            key: e.key,
            value: e.value,
          })),
        })

        // Upsert connection string env vars on the source service
        for (const { key, value } of resolved) {
          await context.prisma.serviceEnvVar.upsert({
            where: { serviceId_key: { serviceId: sourceServiceId, key } },
            create: {
              serviceId: sourceServiceId,
              key,
              value,
              secret: key.includes('PASSWORD'),
              source: `link:${targetServiceId}`,
            },
            update: {
              value,
              source: `link:${targetServiceId}`,
            },
          })
        }
      }
    }

    return link
  },

  unlinkServices: async (
    _: unknown,
    {
      sourceServiceId,
      targetServiceId,
    }: { sourceServiceId: string; targetServiceId: string },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')
    await verifyServiceOwnership(context.prisma, sourceServiceId, context.userId)

    // Also remove any env vars that were auto-generated from this link
    await context.prisma.serviceEnvVar.deleteMany({
      where: {
        serviceId: sourceServiceId,
        source: `link:${targetServiceId}`,
      },
    })

    await context.prisma.serviceLink.delete({
      where: {
        sourceServiceId_targetServiceId: {
          sourceServiceId,
          targetServiceId,
        },
      },
    })
    return true
  },
}
