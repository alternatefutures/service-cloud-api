/**
 * Template Resolvers
 *
 * Handles template browsing (public, no auth required) and
 * template deployment (auth required, creates Service + deploys to Akash).
 */

import { randomBytes } from 'crypto'
import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
import { generateInternalHostname } from '../utils/internalHostname.js'
import {
  getAllTemplates,
  getTemplateById,
  generateSDLFromTemplate,
  generateComposeFromTemplate,
  getEnvKeysFromTemplate,
} from '../templates/index.js'
import {
  resolveConnectionStrings,
  getConnectionStringsForTemplate,
} from '../utils/connectionStrings.js'
import type { TemplateCategory } from '../templates/index.js'
import type { Template, TemplateCompanion } from '../templates/schema.js'
import type { Context } from './types.js'

// ─── Queries ─────────────────────────────────────────────────────

export const templateQueries = {
  templates: (
    _: unknown,
    { category }: { category?: TemplateCategory },
  ) => {
    return getAllTemplates(category ?? undefined)
  },

  template: (_: unknown, { id }: { id: string }) => {
    return getTemplateById(id) ?? null
  },
}

// ─── Helpers ─────────────────────────────────────────────────────

function genPassword(len = 32): string {
  return randomBytes(len).toString('base64url').slice(0, len)
}

/**
 * Create companion services (e.g. postgres) for a template, auto-link them,
 * and inject connection string env vars on the primary service.
 */
async function createCompanionServices(
  prisma: Context['prisma'],
  primaryService: { id: string; slug: string; projectId: string },
  projectSlug: string,
  companions: TemplateCompanion[],
): Promise<void> {
  for (const companion of companions) {
    const companionTemplate = getTemplateById(companion.templateId)
    if (!companionTemplate) {
      console.warn(`[Templates] Companion template not found: ${companion.templateId}`)
      continue
    }

    const companionName = companion.namePrefix
      ? `${companion.namePrefix}-${Date.now().toString(36)}`
      : `${primaryService.slug}-${companion.templateId}-${Date.now().toString(36)}`
    const companionSlug = generateSlug(companionName)

    const companionService = await prisma.service.create({
      data: {
        name: companionName,
        slug: companionSlug,
        type: companionTemplate.serviceType,
        projectId: primaryService.projectId,
        templateId: companion.templateId,
        internalHostname: generateInternalHostname(companionSlug, projectSlug),
        parentServiceId: primaryService.id,
      },
    })

    const envValues: Record<string, string> = {}
    for (const ev of companionTemplate.envVars) {
      const val = companion.envDefaults?.[ev.key] ?? ev.default
      if (val !== null && val !== undefined) envValues[ev.key] = val
    }
    if (!envValues.POSTGRES_PASSWORD && companion.templateId === 'postgres') {
      envValues.POSTGRES_PASSWORD = genPassword()
    }

    if (companionTemplate.envVars?.length) {
      await prisma.$transaction(
        companionTemplate.envVars.map(ev =>
          prisma.serviceEnvVar.create({
            data: {
              serviceId: companionService.id,
              key: ev.key,
              value: envValues[ev.key] ?? ev.default ?? '',
              secret: ev.secret ?? false,
            },
          })
        )
      )
    }
    if (companionTemplate.ports?.length) {
      await prisma.$transaction(
        companionTemplate.ports.map(p =>
          prisma.servicePort.create({
            data: {
              serviceId: companionService.id,
              containerPort: p.port,
              publicPort: p.global ? p.as : null,
              protocol: 'TCP',
            },
          })
        )
      )
    }

    if (companion.autoLink) {
      await prisma.serviceLink.create({
        data: {
          sourceServiceId: primaryService.id,
          targetServiceId: companionService.id,
          alias: companion.templateId,
        },
      })

      const connStrings = getConnectionStringsForTemplate(companionTemplate)
      if (connStrings) {
        const companionEnvVars = await prisma.serviceEnvVar.findMany({
          where: { serviceId: companionService.id },
        })
        const companionPorts = await prisma.servicePort.findMany({
          where: { serviceId: companionService.id },
        })
        const resolved = resolveConnectionStrings(connStrings, {
          internalHostname: companionService.internalHostname,
          slug: companionSlug,
          ports: companionPorts.map(p => ({
            containerPort: p.containerPort,
            publicPort: p.publicPort,
          })),
          envVars: companionEnvVars.map(e => ({ key: e.key, value: e.value })),
        })

        for (const { key, value } of resolved) {
          await prisma.serviceEnvVar.upsert({
            where: { serviceId_key: { serviceId: primaryService.id, key } },
            create: {
              serviceId: primaryService.id,
              key,
              value,
              secret: key.includes('PASSWORD'),
              source: `link:${companionService.id}`,
            },
            update: {
              value,
              source: `link:${companionService.id}`,
            },
          })
        }
      }
    }

    console.log(`[Templates] Created companion service '${companionName}' (${companion.templateId}) linked to '${primaryService.slug}'`)
  }
}

// ─── Mutations ───────────────────────────────────────────────────

export const templateMutations = {
  deployFromTemplate: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        templateId: string
        projectId: string
        serviceName?: string
        envOverrides?: Array<{ key: string; value: string }>
        resourceOverrides?: { cpu?: number; memory?: string; storage?: string; gpu?: { units: number; vendor: string; model?: string } | null }
      }
    },
    context: Context,
  ) => {
    // ── Auth ──────────────────────────────────────────────────
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    // ── Look up template ─────────────────────────────────────
    const template = getTemplateById(input.templateId)
    if (!template) {
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    }

    // ── Verify project exists and belongs to user ────────────
    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) {
      throw new GraphQLError('Project not found')
    }

    // ── Create service in registry ───────────────────────────
    const serviceName = input.serviceName || `${template.id}-${Date.now().toString(36)}`
    const slug = generateSlug(serviceName)

    const service = await context.prisma.service.create({
      data: {
        name: serviceName,
        slug,
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        internalHostname: generateInternalHostname(slug, project.slug),
      },
    })

    // ── Persist template default env vars and ports ──────────
    if (template.envVars?.length) {
      await context.prisma.$transaction(
        template.envVars.map((ev: any) =>
          context.prisma.serviceEnvVar.create({
            data: {
              serviceId: service.id,
              key: ev.key,
              value: (input.envOverrides ?? []).find((o: any) => o.key === ev.key)?.value ?? ev.default ?? '',
              secret: ev.secret ?? false,
            },
          })
        )
      )
    }
    if (template.ports?.length) {
      await context.prisma.$transaction(
        template.ports.map((p: any) =>
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

    // ── Create companion services (e.g. postgres) ────────────
    if (template.companions?.length) {
      await createCompanionServices(
        context.prisma,
        { id: service.id, slug, projectId: input.projectId },
        project.slug,
        template.companions,
      )
    }

    // ── Convert env overrides from array to Record ───────────
    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    // ── Build resource overrides ─────────────────────────────
    const resourceOverrides = input.resourceOverrides
      ? {
          cpu: input.resourceOverrides.cpu ?? undefined,
          memory: input.resourceOverrides.memory ?? undefined,
          storage: input.resourceOverrides.storage ?? undefined,
          gpu: input.resourceOverrides.gpu === null
            ? null
            : input.resourceOverrides.gpu
              ? { units: input.resourceOverrides.gpu.units, vendor: input.resourceOverrides.gpu.vendor as 'nvidia', model: input.resourceOverrides.gpu.model ?? undefined }
              : undefined,
        }
      : undefined

    // ── Generate SDL from template ───────────────────────────
    const sdlContent = generateSDLFromTemplate(template, {
      serviceName: slug,
      envOverrides,
      resourceOverrides,
    })

    // ── Deploy to Akash via orchestrator ─────────────────────
    const { getAkashOrchestrator } = await import(
      '../services/akash/orchestrator.js'
    )
    const orchestrator = getAkashOrchestrator(context.prisma)

    try {
      const deploymentId = await orchestrator.deployService(service.id, {
        sdlContent,
      })

      const deployment = await context.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
      })

      if (!deployment) {
        throw new GraphQLError('Deployment record not found after creation')
      }

      return {
        ...deployment,
        dseq: deployment.dseq.toString(),
        depositUakt: deployment.depositUakt?.toString() ?? null,
      }
    } catch (error: any) {
      throw new GraphQLError(
        `Template deployment failed: ${error.message || 'Unknown error'}`,
      )
    }
  },

  deployFromTemplateToPhala: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        templateId: string
        projectId: string
        serviceName?: string
        envOverrides?: Array<{ key: string; value: string }>
        resourceOverrides?: { cpu?: number; memory?: string; storage?: string; gpu?: { units: number; vendor: string; model?: string } | null }
      }
    },
    context: Context,
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const template = getTemplateById(input.templateId)
    if (!template) {
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    }

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) throw new GraphQLError('Project not found')

    const serviceName = input.serviceName || `${template.id}-${Date.now().toString(36)}`
    const slug = generateSlug(serviceName)

    const service = await context.prisma.service.create({
      data: {
        name: serviceName,
        slug,
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        internalHostname: generateInternalHostname(slug, project.slug),
      },
    })

    // Persist template default env vars and ports
    if (template.envVars?.length) {
      await context.prisma.$transaction(
        template.envVars.map((ev: any) =>
          context.prisma.serviceEnvVar.create({
            data: {
              serviceId: service.id,
              key: ev.key,
              value: (input.envOverrides ?? []).find((o: any) => o.key === ev.key)?.value ?? ev.default ?? '',
              secret: ev.secret ?? false,
            },
          })
        )
      )
    }
    if (template.ports?.length) {
      await context.prisma.$transaction(
        template.ports.map((p: any) =>
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

    // ── Create companion services (e.g. postgres) ────────────
    if (template.companions?.length) {
      await createCompanionServices(
        context.prisma,
        { id: service.id, slug, projectId: input.projectId },
        project.slug,
        template.companions,
      )
    }

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    const composeContent = generateComposeFromTemplate(template, {
      serviceName: slug,
      envOverrides,
      resourceOverrides: input.resourceOverrides
        ? {
            cpu: input.resourceOverrides.cpu ?? undefined,
            memory: input.resourceOverrides.memory ?? undefined,
            storage: input.resourceOverrides.storage ?? undefined,
          }
        : undefined,
    })

    const envKeys = getEnvKeysFromTemplate(template, envOverrides)

    const mergedEnv: Record<string, string> = {}
    for (const v of template.envVars) {
      if (v.default !== null) mergedEnv[v.key] = v.default
    }
    Object.assign(mergedEnv, envOverrides)

    const { getPhalaOrchestrator } = await import(
      '../services/phala/orchestrator.js'
    )
    const orchestrator = getPhalaOrchestrator(context.prisma)

    const gpuModel = input.resourceOverrides?.gpu?.model ?? template.resources.gpu?.model ?? undefined

    try {
      const deploymentId = await orchestrator.deployServicePhala(service.id, {
        composeContent,
        env: mergedEnv,
        envKeys,
        name: `af-${slug}-${Date.now().toString(36)}`,
        gpuModel,
      })

      const deployment = await context.prisma.phalaDeployment.findUnique({
        where: { id: deploymentId },
      })

      if (!deployment) {
        throw new GraphQLError('Phala deployment record not found after creation')
      }

      return deployment
    } catch (error: any) {
      throw new GraphQLError(
        `Phala deployment failed: ${error.message || 'Unknown error'}`,
      )
    }
  },
}
