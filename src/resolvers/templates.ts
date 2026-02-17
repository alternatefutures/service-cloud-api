/**
 * Template Resolvers
 *
 * Handles template browsing (public, no auth required) and
 * template deployment (auth required, creates Service + deploys to Akash).
 */

import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
import {
  getAllTemplates,
  getTemplateById,
  generateSDLFromTemplate,
  generateComposeFromTemplate,
  getEnvKeysFromTemplate,
} from '../templates/index.js'
import type { TemplateCategory } from '../templates/index.js'
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
        resourceOverrides?: { cpu?: number; memory?: string; storage?: string }
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
      },
    })

    // ── Convert env overrides from array to Record ───────────
    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    // ── Generate SDL from template ───────────────────────────
    const sdlContent = generateSDLFromTemplate(template, {
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

    // ── Deploy to Akash via orchestrator ─────────────────────
    // Import dynamically to avoid circular deps
    const { getAkashOrchestrator } = await import(
      '../services/akash/orchestrator.js'
    )
    const orchestrator = getAkashOrchestrator(context.prisma)

    try {
      const deploymentId = await orchestrator.deployService(service.id, {
        sdlContent,
        deposit: input.envOverrides
          ? undefined // Use default deposit
          : undefined,
      })

      // deployService returns a string ID — fetch the full record for GraphQL
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
      // If deployment fails, still return a useful error
      // The AkashDeployment record is created with FAILED status by the orchestrator
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
        resourceOverrides?: { cpu?: number; memory?: string; storage?: string }
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
      },
    })

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

    try {
      const deploymentId = await orchestrator.deployServicePhala(service.id, {
        composeContent,
        env: mergedEnv,
        envKeys,
        name: `af-${slug}-${Date.now().toString(36)}`,
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
