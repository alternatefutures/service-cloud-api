/**
 * Template Resolvers
 *
 * Handles template browsing (public, no auth required) and
 * template deployment (auth required, creates Service + deploys to Akash).
 */

import { randomBytes } from 'crypto'
import { GraphQLError } from 'graphql'
import { generateSlug } from '../utils/slug.js'
import { assertSubscriptionActive } from './subscriptionCheck.js'
import { generateInternalHostname } from '../utils/internalHostname.js'
import {
  getAllTemplates,
  getTemplateById,
  generateSDLFromTemplate,
  generateComposeFromTemplate,
  generateCompositeSDL,
  generateCompositeCompose,
  getEnvKeysFromTemplate,
  resolveEnvLinks,
  slugify,
  generatePassword,
  generateBase64Secret,
} from '../templates/index.js'
import type { ResolvedComponent, CompositeContext } from '../templates/index.js'
import {
  resolveConnectionStrings,
  getConnectionStringsForTemplate,
} from '../utils/connectionStrings.js'
import type { TemplateCategory } from '../templates/index.js'
import type {
  Template,
  TemplateCompanion,
  TemplateComponent,
} from '../templates/schema.js'
import type { Context } from './types.js'
import { injectPlatformEnvVars } from '../services/billing/platformEnvClient.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('resolver-templates')

// ─── Queries ─────────────────────────────────────────────────────

export const templateQueries = {
  templates: (_: unknown, { category }: { category?: TemplateCategory }) => {
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
  companions: TemplateCompanion[]
): Promise<void> {
  for (const companion of companions) {
    const companionTemplate = getTemplateById(companion.templateId)
    if (!companionTemplate) {
      log.warn(`Companion template not found: ${companion.templateId}`)
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

    log.info(
      `Created companion service '${companionName}' (${companion.templateId}) linked to '${primaryService.slug}'`
    )
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
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
      }
    },
    context: Context
  ) => {
    // ── Subscription check ────────────────────────────────────
    await assertSubscriptionActive(context.organizationId)

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
    const serviceName =
      input.serviceName || `${template.id}-${Date.now().toString(36)}`
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
              value:
                (input.envOverrides ?? []).find((o: any) => o.key === ev.key)
                  ?.value ??
                ev.default ??
                '',
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
        template.companions
      )
    }

    // ── Convert env overrides from array to Record ───────────
    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    // ── Auto-inject platform env vars (AF_ORG_ID, AF_API_KEY) ─
    await injectPlatformEnvVars(template, envOverrides, context, slug)

    // ── Build resource overrides ─────────────────────────────
    const resourceOverrides = input.resourceOverrides
      ? {
          cpu: input.resourceOverrides.cpu ?? undefined,
          memory: input.resourceOverrides.memory ?? undefined,
          storage: input.resourceOverrides.storage ?? undefined,
          gpu:
            input.resourceOverrides.gpu === null
              ? null
              : input.resourceOverrides.gpu
                ? {
                    units: input.resourceOverrides.gpu.units,
                    vendor: input.resourceOverrides.gpu.vendor as 'nvidia',
                    model: input.resourceOverrides.gpu.model ?? undefined,
                  }
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
    const { getAkashOrchestrator } =
      await import('../services/akash/orchestrator.js')
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
        `Template deployment failed: ${error.message || 'Unknown error'}`
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
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
      }
    },
    context: Context
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

    const serviceName =
      input.serviceName || `${template.id}-${Date.now().toString(36)}`
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
              value:
                (input.envOverrides ?? []).find((o: any) => o.key === ev.key)
                  ?.value ??
                ev.default ??
                '',
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
        template.companions
      )
    }

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    // ── Auto-inject platform env vars (AF_ORG_ID, AF_API_KEY) ─
    await injectPlatformEnvVars(template, envOverrides, context, slug)

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

    const { getPhalaOrchestrator } =
      await import('../services/phala/orchestrator.js')
    const orchestrator = getPhalaOrchestrator(context.prisma)

    const gpuModel =
      input.resourceOverrides?.gpu?.model ??
      template.resources.gpu?.model ??
      undefined

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
        throw new GraphQLError(
          'Phala deployment record not found after creation'
        )
      }

      return deployment
    } catch (error: any) {
      throw new GraphQLError(
        `Phala deployment failed: ${error.message || 'Unknown error'}`
      )
    }
  },

  // ─── Composite Template Deployment ────────────────────────────

  deployCompositeTemplate: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        templateId: string
        projectId: string
        mode: 'fullstack' | 'custom'
        provider?: string
        componentTargets?: Array<{
          componentId: string
          provider: string
          resourceOverrides?: {
            cpu?: number
            memory?: string
            storage?: string
            gpu?: { units: number; vendor: string; model?: string } | null
          }
        }>
        serviceName?: string
        envOverrides?: Array<{ key: string; value: string }>
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
      }
    },
    context: Context
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const template = getTemplateById(input.templateId)
    if (!template)
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    if (!template.components?.length)
      throw new GraphQLError('Template has no components')

    // Build topology from user input
    type Target = {
      componentId: string
      provider: 'akash' | 'phala'
      group: string
    }
    const targets: Target[] = []

    if (input.mode === 'fullstack') {
      const prov = (input.provider === 'phala' ? 'phala' : 'akash') as
        | 'akash'
        | 'phala'
      for (const comp of template.components) {
        targets.push({ componentId: comp.id, provider: prov, group: 'main' })
      }
    } else {
      if (!input.componentTargets?.length) {
        throw new GraphQLError('Custom mode requires componentTargets')
      }
      let akashCounter = 0
      let phalaCounter = 0
      for (const ct of input.componentTargets) {
        const prov = (ct.provider === 'phala' ? 'phala' : 'akash') as
          | 'akash'
          | 'phala'
        const group =
          prov === 'akash' ? `akash-${akashCounter++}` : `tee-${phalaCounter++}`
        targets.push({ componentId: ct.componentId, provider: prov, group })
      }
    }

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) throw new GraphQLError('Project not found')

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) envOverrides[key] = value
    }

    // ── Auto-inject platform env vars (AF_ORG_ID, AF_API_KEY) ─
    const primarySlug = generateSlug(
      input.serviceName || `${template.id}-${Date.now().toString(36)}`
    )
    await injectPlatformEnvVars(template, envOverrides, context, primarySlug)

    // ── Resolve components ──────────────────────────────────────
    const activeComponentIds = new Set(targets.map(t => t.componentId))
    const activeComponents = template.components.filter(c =>
      activeComponentIds.has(c.id)
    )

    const password = generatePassword()
    const secret = generateBase64Secret()

    const baseName =
      input.serviceName || `${template.id}-${Date.now().toString(36)}`

    const slugs: Record<string, string> = {}
    const groups: Record<string, string> = {}
    const providers: Record<string, 'akash' | 'phala'> = {}
    for (const target of targets) {
      const comp = activeComponents.find(c => c.id === target.componentId)
      if (!comp) continue
      const suffix = comp.primary ? '' : `-${comp.id}`
      slugs[comp.id] = generateSlug(`${baseName}${suffix}`)
      groups[comp.id] = target.group
      providers[comp.id] = target.provider
    }

    // Auto-merge Akash groups for components that need internal access
    // to internalOnly dependencies (they must share an Akash lease for
    // DNS-based service discovery to work).
    for (const comp of activeComponents) {
      if (!comp.envLinks) continue
      for (const templateValue of Object.values(comp.envLinks)) {
        const matches = templateValue.matchAll(
          /\{\{component\.([^.]+)\.host\}\}/g
        )
        for (const match of matches) {
          const targetId = match[1]
          const targetComp = activeComponents.find(
            candidate => candidate.id === targetId
          )
          if (!targetComp?.internalOnly) continue

          if (
            providers[comp.id] !== 'akash' ||
            providers[targetId] !== 'akash'
          ) {
            throw new GraphQLError(
              `Component '${comp.id}' requires internal access to '${targetId}', but they are on different providers. Both must be on Akash.`
            )
          }

          if (groups[comp.id] !== groups[targetId]) {
            const mergedGroup = groups[targetId]
            const oldGroup = groups[comp.id]
            for (const [id, g] of Object.entries(groups)) {
              if (g === oldGroup) groups[id] = mergedGroup
            }
          }
        }
      }
    }

    const ctx: CompositeContext = { slugs, groups, providers, password, secret }

    const resolved: ResolvedComponent[] = []
    for (const comp of activeComponents) {
      const r = resolveComponent(comp, template, envOverrides, ctx)
      resolved.push(r)
    }

    // Apply per-component resource overrides (custom mode)
    if (input.componentTargets) {
      for (const ct of input.componentTargets) {
        if (!ct.resourceOverrides) continue
        const r = resolved.find(rc => rc.id === ct.componentId)
        if (!r) continue
        const ro = ct.resourceOverrides
        const gpuOverride =
          ro.gpu === null || ro.gpu === undefined
            ? undefined
            : {
                units: ro.gpu.units,
                vendor: ro.gpu.vendor as 'nvidia',
                model: ro.gpu.model ?? undefined,
              }
        r.resources = {
          cpu: ro.cpu ?? r.resources.cpu,
          memory: ro.memory ?? r.resources.memory,
          storage: ro.storage ?? r.resources.storage,
          gpu: gpuOverride,
        }
      }
    }

    // Fullstack mode: apply global resourceOverrides to the primary component
    if (input.mode === 'fullstack' && input.resourceOverrides) {
      const ro = input.resourceOverrides
      const primary = resolved.find(
        rc => activeComponents.find(c => c.id === rc.id)?.primary
      )
      if (primary) {
        const gpuOverride =
          ro.gpu === null || ro.gpu === undefined
            ? undefined
            : {
                units: ro.gpu.units,
                vendor: ro.gpu.vendor as 'nvidia',
                model: ro.gpu.model ?? undefined,
              }
        primary.resources = {
          cpu: ro.cpu ?? primary.resources.cpu,
          memory: ro.memory ?? primary.resources.memory,
          storage: ro.storage ?? primary.resources.storage,
          gpu: gpuOverride,
        }
      }
    }

    for (const comp of activeComponents) {
      if (!comp.envLinks) continue
      const r = resolved.find(rc => rc.id === comp.id)!
      const linked = resolveEnvLinks(comp.envLinks, comp.id, resolved, ctx)
      Object.assign(r.resolvedEnv, linked)
    }

    // ── Group by deployment target ──────────────────────────────
    const akashGroups = new Map<string, ResolvedComponent[]>()
    const phalaComponents: ResolvedComponent[] = []

    for (const target of targets) {
      const r = resolved.find(rc => rc.id === target.componentId)
      if (!r) continue
      if (target.provider === 'akash') {
        const list = akashGroups.get(target.group) || []
        list.push(r)
        akashGroups.set(target.group, list)
      } else {
        phalaComponents.push(r)
      }
    }

    // ── Create Service records ──────────────────────────────────
    const primaryComp =
      resolved.find(r => activeComponents.find(c => c.id === r.id)?.primary) ??
      resolved[0]

    const primaryService = await context.prisma.service.create({
      data: {
        name: baseName,
        slug: slugs[primaryComp.id],
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        internalHostname: generateInternalHostname(
          slugs[primaryComp.id],
          project.slug
        ),
        sdlServiceName: primaryComp.sdlServiceName,
      },
    })

    const serviceIds: Record<string, string> = {
      [primaryComp.id]: primaryService.id,
    }

    for (const comp of resolved) {
      if (comp.id === primaryComp.id) continue
      const compDef = activeComponents.find(c => c.id === comp.id)!
      const svc = await context.prisma.service.create({
        data: {
          name: `${baseName}-${comp.id}`,
          slug: slugs[comp.id],
          type: compDef.templateId
            ? (getTemplateById(compDef.templateId)?.serviceType ?? 'VM')
            : template.serviceType,
          projectId: input.projectId,
          templateId: compDef.templateId ?? input.templateId,
          internalHostname: generateInternalHostname(
            slugs[comp.id],
            project.slug
          ),
          parentServiceId: primaryService.id,
          sdlServiceName: comp.sdlServiceName,
        },
      })
      serviceIds[comp.id] = svc.id
    }

    // Persist env vars and ports for each service
    for (const comp of resolved) {
      const svcId = serviceIds[comp.id]
      const envEntries = Object.entries(comp.resolvedEnv)
      if (envEntries.length > 0) {
        await context.prisma.$transaction(
          envEntries.map(([key, value]) =>
            context.prisma.serviceEnvVar.create({
              data: {
                serviceId: svcId,
                key,
                value,
                secret: key.includes('PASSWORD') || key.includes('SECRET'),
              },
            })
          )
        )
      }
      if (comp.ports.length > 0) {
        await context.prisma.$transaction(
          comp.ports.map(p =>
            context.prisma.servicePort.create({
              data: {
                serviceId: svcId,
                containerPort: p.port,
                publicPort: p.global ? p.as : null,
                protocol: 'TCP',
              },
            })
          )
        )
      }
    }

    // ── Deploy Akash groups ─────────────────────────────────────
    for (const [groupName, groupComponents] of akashGroups) {
      const sdlContent = generateCompositeSDL(groupComponents)
      log.info(
        `Group '${groupName}' SDL (${groupComponents.length} services):\n${sdlContent}`
      )
      const { getAkashOrchestrator } =
        await import('../services/akash/orchestrator.js')
      const orchestrator = getAkashOrchestrator(context.prisma)

      const groupPrimary = groupComponents.find(c => c.id === primaryComp.id)
      const deployServiceId = groupPrimary
        ? primaryService.id
        : serviceIds[groupComponents[0].id]

      try {
        await orchestrator.deployService(deployServiceId, {
          sdlContent,
          skipEnvInjection: true,
        })
      } catch (error: any) {
        throw new GraphQLError(
          `Composite deployment failed (Akash): ${error.message || 'Unknown error'}`
        )
      }
    }

    // ── Deploy Phala components ──────────────────────────────────
    for (const comp of phalaComponents) {
      const composeContent = generateCompositeCompose(comp)
      const envKeys = Object.keys(comp.resolvedEnv)
      const { getPhalaOrchestrator } =
        await import('../services/phala/orchestrator.js')
      const orchestrator = getPhalaOrchestrator(context.prisma)
      const svcId = serviceIds[comp.id]

      try {
        await orchestrator.deployServicePhala(svcId, {
          composeContent,
          env: comp.resolvedEnv,
          envKeys,
          name: `af-${slugs[comp.id]}-${Date.now().toString(36)}`,
        })
      } catch (error: any) {
        throw new GraphQLError(
          `Composite deployment failed (Phala): ${error.message || 'Unknown error'}`
        )
      }
    }

    return { primaryServiceId: primaryService.id }
  },
}

// ─── Component Resolution ─────────────────────────────────────────

function resolveComponent(
  comp: TemplateComponent,
  parentTemplate: Template,
  envOverrides: Record<string, string>,
  ctx: CompositeContext
): ResolvedComponent {
  const sdlName = comp.sdlServiceName ?? comp.id

  if (comp.primary) {
    const env: Record<string, string> = {}
    for (const v of parentTemplate.envVars) {
      if (v.default !== null) env[v.key] = v.default
    }
    if (parentTemplate.akash) {
      const a = parentTemplate.akash
      if (a.chownPaths?.length)
        env['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
      if (a.runUser) env['AKASH_RUN_USER'] = a.runUser
      if (a.runUid != null) env['AKASH_RUN_UID'] = String(a.runUid)
    }
    for (const [k, v] of Object.entries(envOverrides)) env[k] = v

    return {
      id: comp.id,
      sdlServiceName: sdlName,
      dockerImage: parentTemplate.dockerImage,
      resources: parentTemplate.resources,
      ports: parentTemplate.ports,
      envVars: parentTemplate.envVars,
      persistentStorage: parentTemplate.persistentStorage ?? [],
      healthCheck: parentTemplate.healthCheck,
      startCommand: comp.startCommand ?? parentTemplate.startCommand,
      akash: parentTemplate.akash,
      pricingUakt: parentTemplate.pricingUakt ?? 1000,
      internalOnly: comp.internalOnly ?? false,
      resolvedEnv: env,
    }
  }

  if (comp.templateId) {
    const ref = getTemplateById(comp.templateId)
    if (!ref)
      throw new GraphQLError(
        `Referenced template not found: ${comp.templateId}`
      )

    const env: Record<string, string> = {}
    for (const v of ref.envVars) {
      if (v.default !== null) env[v.key] = v.default
    }
    if (comp.envDefaults) {
      for (const [k, v] of Object.entries(comp.envDefaults)) env[k] = v
    }
    if (ref.akash) {
      const a = ref.akash
      if (a.chownPaths?.length)
        env['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
      if (a.runUser) env['AKASH_RUN_USER'] = a.runUser
      if (a.runUid != null) env['AKASH_RUN_UID'] = String(a.runUid)
    }
    const isPostgres = comp.templateId === 'postgres' ||
      ref.dockerImage.startsWith('postgres') ||
      ref.dockerImage.startsWith('pgvector/')
    if (isPostgres && !env.POSTGRES_PASSWORD) {
      env.POSTGRES_PASSWORD = ctx.password
    }

    return {
      id: comp.id,
      sdlServiceName: sdlName,
      dockerImage: ref.dockerImage,
      resources: ref.resources,
      ports: ref.ports,
      envVars: ref.envVars,
      persistentStorage: ref.persistentStorage ?? [],
      healthCheck: ref.healthCheck,
      startCommand: comp.startCommand ?? ref.startCommand,
      akash: ref.akash,
      pricingUakt: ref.pricingUakt ?? 1000,
      internalOnly: comp.internalOnly ?? false,
      resolvedEnv: env,
    }
  }

  if (comp.inline) {
    const env: Record<string, string> = {}
    for (const v of comp.inline.envVars ?? []) {
      if (v.default !== null) env[v.key] = v.default
    }
    if (comp.envDefaults) {
      for (const [k, v] of Object.entries(comp.envDefaults)) env[k] = v
    }

    return {
      id: comp.id,
      sdlServiceName: sdlName,
      dockerImage: comp.inline.dockerImage,
      resources: comp.inline.resources,
      ports: comp.inline.ports ?? [],
      envVars: comp.inline.envVars ?? [],
      persistentStorage: comp.inline.persistentStorage ?? [],
      healthCheck: comp.inline.healthCheck,
      startCommand: comp.inline.startCommand,
      akash: comp.inline.akash,
      pricingUakt: comp.inline.pricingUakt ?? 1000,
      internalOnly: comp.internalOnly ?? false,
      resolvedEnv: env,
    }
  }

  throw new GraphQLError(
    `Component '${comp.id}' has no source (primary, templateId, or inline)`
  )
}

// ─── Field Resolvers ──────────────────────────────────────────────

export const templateFieldResolvers = {
  TemplateComponent: {
    defaultResources: (
      parent: TemplateComponent & { _parentTemplate?: Template }
    ) => {
      if (parent.primary && parent._parentTemplate) {
        return parent._parentTemplate.resources
      }
      if (parent.templateId) {
        const ref = getTemplateById(parent.templateId)
        return ref?.resources ?? null
      }
      if ((parent as any).inline?.resources) {
        return (parent as any).inline.resources
      }
      return null
    },
  },
}

// Wrap template query results to attach parent reference to components
const origTemplates = templateQueries.templates
const origTemplate = templateQueries.template
templateQueries.templates = (...args: Parameters<typeof origTemplates>) => {
  const results = origTemplates(...args) as Template[]
  return results.map(t => attachParentToComponents(t))
}
templateQueries.template = (...args: Parameters<typeof origTemplate>) => {
  const t = origTemplate(...args) as Template | null
  return t ? attachParentToComponents(t) : null
}

function attachParentToComponents(t: Template): Template {
  if (!t.components) return t
  return {
    ...t,
    components: t.components.map(c => ({ ...c, _parentTemplate: t })),
  }
}
