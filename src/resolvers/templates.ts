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
import { assertDeployBalance } from './balanceCheck.js'
import { BILLING_CONFIG } from '../config/billing.js'
import { applyMargin } from '../config/pricing.js'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
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
  TemplateResources,
} from '../templates/schema.js'
import type { Context } from './types.js'
import { injectPlatformEnvVars } from '../services/billing/platformEnvClient.js'
import { createLogger } from '../lib/logger.js'
import { resolvePhalaInstanceType } from '../services/phala/instanceTypes.js'
import { validatePolicyInput } from '../services/policy/validator.js'
import type { DeploymentPolicyInput } from '../services/policy/types.js'
import { assertProjectAccess } from '../utils/authorization.js'

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

function defaultServiceNameForTemplate(template: Template): string {
  return `${generateSlug(template.name)}-${Date.now().toString(36)}`
}

type ResourceOverrideInput = {
  cpu?: number
  memory?: string
  storage?: string
  gpu?: { units: number; vendor: string; model?: string } | null
}

type CompositeServiceMutationData = {
  name: string
  slug: string
  type: Template['serviceType']
  projectId: string
  templateId: string
  createdByUserId: string | null
  internalHostname: string
  sdlServiceName?: string
  parentServiceId?: string | null
}

function normalizeResourceOverrides(input?: ResourceOverrideInput) {
  if (!input) return undefined

  return {
    cpu: input.cpu ?? undefined,
    memory: input.memory ?? undefined,
    storage: input.storage ?? undefined,
    gpu:
      input.gpu === null
        ? null
        : input.gpu
          ? {
              units: input.gpu.units,
              vendor: input.gpu.vendor as 'nvidia',
              model: input.gpu.model ?? undefined,
            }
          : undefined,
  }
}

function resolveTemplateResources(
  templateResources: TemplateResources,
  overrides?: ReturnType<typeof normalizeResourceOverrides>
): TemplateResources {
  return {
    cpu: overrides?.cpu ?? templateResources.cpu,
    memory: overrides?.memory ?? templateResources.memory,
    storage: overrides?.storage ?? templateResources.storage,
    gpu:
      overrides?.gpu === null
        ? undefined
        : (overrides?.gpu ?? templateResources.gpu),
  }
}

export async function upsertCompositeServiceRecord(
  prisma: Context['prisma'],
  existingServiceId: string | undefined,
  data: CompositeServiceMutationData
) {
  if (existingServiceId) {
    return prisma.service.update({
      where: { id: existingServiceId },
      data,
    })
  }

  return prisma.service.create({ data })
}

export async function replaceCompositeServiceConfig(
  prisma: Context['prisma'],
  serviceId: string,
  envEntries: Array<[string, string]>,
  ports: Array<{ port: number; as: number; global: boolean }>
) {
  await prisma.serviceEnvVar.deleteMany({
    where: { serviceId },
  })
  await prisma.servicePort.deleteMany({
    where: { serviceId },
  })

  if (envEntries.length > 0) {
    await prisma.$transaction(
      envEntries.map(([key, value]) =>
        prisma.serviceEnvVar.create({
          data: {
            serviceId,
            key,
            value,
            secret: key.includes('PASSWORD') || key.includes('SECRET'),
          },
        })
      )
    )
  }

  if (ports.length > 0) {
    await prisma.$transaction(
      ports.map(p =>
        prisma.servicePort.create({
          data: {
            serviceId,
            containerPort: p.port,
            publicPort: p.global ? p.as : null,
            protocol: 'TCP',
          },
        })
      )
    )
  }
}

function assertRequiredTemplateEnvVars(
  template: Template,
  envOverrides: Record<string, string>
): void {
  const missingKeys = template.envVars
    .filter(envVar => envVar.required)
    .map(envVar => {
      const resolvedValue = envOverrides[envVar.key] ?? envVar.default ?? ''
      return { key: envVar.key, value: resolvedValue }
    })
    .filter(({ value }) => value.trim() === '')
    .map(({ key }) => key)

  if (missingKeys.length > 0) {
    throw new GraphQLError(
      `Missing required environment variables: ${missingKeys.join(', ')}`
    )
  }
}

/**
 * Create companion services (e.g. postgres) for a template, auto-link them,
 * and inject connection string env vars on the primary service.
 */
async function createCompanionServices(
  prisma: Context['prisma'],
  primaryService: { id: string; slug: string; projectId: string; createdByUserId?: string | null },
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
        createdByUserId: primaryService.createdByUserId ?? null,
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
        policy?: DeploymentPolicyInput
      }
    },
    context: Context
  ) => {
    // ── Pre-deploy gates ────────────────────────────────────
    await assertSubscriptionActive(context.organizationId)

    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    const template = getTemplateById(input.templateId)
    if (!template) {
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    }

    const gpuUnits = input.resourceOverrides?.gpu?.units ?? template.resources.gpu?.units ?? 0
    const estimatedCost = gpuUnits > 0
      ? BILLING_CONFIG.thresholds.failClosedAboveCentsPerDay * gpuUnits
      : BILLING_CONFIG.akash.minBalanceCentsToLaunch
    await assertDeployBalance(context.organizationId, 'akash', context.prisma, {
      dailyCostCents: estimatedCost,
    })

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) {
      throw new GraphQLError('Project not found')
    }
    assertProjectAccess(context, project, 'Not authorized to deploy to this project')

    const serviceName =
      input.serviceName || defaultServiceNameForTemplate(template)
    const slug = generateSlug(serviceName)

    // ── Resolve env vars before persisting/deploying ─────────
    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    await injectPlatformEnvVars(template, envOverrides, context, slug)
    assertRequiredTemplateEnvVars(template, envOverrides)

    // ── Create service in registry ───────────────────────────

    const service = await context.prisma.service.create({
      data: {
        name: serviceName,
        slug,
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        createdByUserId: context.userId ?? null,
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
              value: envOverrides[ev.key] ?? ev.default ?? '',
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
        { id: service.id, slug, projectId: input.projectId, createdByUserId: context.userId },
        project.slug,
        template.companions
      )
    }

    // ── Build resource overrides ─────────────────────────────
    const resourceOverrides = normalizeResourceOverrides(
      input.resourceOverrides
    )

    // ── Validate and create deployment policy ────────────────
    let policyId: string | undefined
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
      const policyRecord = await context.prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: input.policy.acceptableGpuModels ?? [],
          gpuUnits: input.policy.gpuUnits ?? null,
          gpuVendor: input.policy.gpuVendor ?? null,
          maxBudgetUsd: input.policy.maxBudgetUsd ?? null,
          maxMonthlyUsd: input.policy.maxMonthlyUsd ?? null,
          runtimeMinutes: input.policy.runtimeMinutes ?? null,
          expiresAt: input.policy.runtimeMinutes
            ? new Date(Date.now() + input.policy.runtimeMinutes * 60_000)
            : null,
        },
      })
      policyId = policyRecord.id
    }

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

      if (policyId) {
        await context.prisma.akashDeployment.update({
          where: { id: deploymentId },
          data: { policyId },
        })
      }

      const deployment = await context.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
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
        policy?: DeploymentPolicyInput
      }
    },
    context: Context
  ) => {
    await assertSubscriptionActive(context.organizationId)
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const template = getTemplateById(input.templateId)
    if (!template) {
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    }

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) throw new GraphQLError('Project not found')
    assertProjectAccess(context, project, 'Not authorized to deploy to this project')

    const serviceName =
      input.serviceName || defaultServiceNameForTemplate(template)
    const slug = generateSlug(serviceName)

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) {
        envOverrides[key] = value
      }
    }

    await injectPlatformEnvVars(template, envOverrides, context, slug)
    assertRequiredTemplateEnvVars(template, envOverrides)

    const service = await context.prisma.service.create({
      data: {
        name: serviceName,
        slug,
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        createdByUserId: context.userId ?? null,
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
              value: envOverrides[ev.key] ?? ev.default ?? '',
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
        { id: service.id, slug, projectId: input.projectId, createdByUserId: context.userId },
        project.slug,
        template.companions
      )
    }

    const resourceOverrides = normalizeResourceOverrides(
      input.resourceOverrides
    )

    // ── Validate and create deployment policy ────────────────
    let policyId: string | undefined
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
      const policyRecord = await context.prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: input.policy.acceptableGpuModels ?? [],
          gpuUnits: input.policy.gpuUnits ?? null,
          gpuVendor: input.policy.gpuVendor ?? null,
          maxBudgetUsd: input.policy.maxBudgetUsd ?? null,
          maxMonthlyUsd: input.policy.maxMonthlyUsd ?? null,
          runtimeMinutes: input.policy.runtimeMinutes ?? null,
          expiresAt: input.policy.runtimeMinutes
            ? new Date(Date.now() + input.policy.runtimeMinutes * 60_000)
            : null,
        },
      })
      policyId = policyRecord.id
    }

    const phalaResources = resolveTemplateResources(
      template.resources,
      resourceOverrides
    )
    const phalaInstance = await resolvePhalaInstanceType(
      phalaResources,
      input.policy?.acceptableGpuModels,
      input.policy?.gpuUnits
    )

    const estimatedDailyCostCents = Math.max(
      BILLING_CONFIG.phala.minBalanceCentsToLaunch,
      Math.ceil(phalaInstance.hourlyRateUsd * 24 * 100)
    )
    await assertDeployBalance(context.organizationId, 'phala', context.prisma, {
      dailyCostCents: estimatedDailyCostCents,
    })

    const composeContent = generateComposeFromTemplate(template, {
      serviceName: slug,
      envOverrides,
      resourceOverrides,
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

    try {
      const deploymentId = await orchestrator.deployServicePhala(service.id, {
        composeContent,
        env: mergedEnv,
        envKeys,
        name: `af-${slug}-${Date.now().toString(36)}`,
        cvmSize: phalaInstance.cvmSize,
        gpuModel: phalaInstance.gpuModel ?? undefined,
        hourlyRateUsd: phalaInstance.hourlyRateUsd,
      })

      if (policyId) {
        await context.prisma.phalaDeployment.update({
          where: { id: deploymentId },
          data: { policyId },
        })
      }

      const deployment = await context.prisma.phalaDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
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

  // ─── Spheron Template Deployment ──────────────────────────────

  /**
   * Mirror of `deployFromTemplateToPhala` for Spheron GPU VMs.
   *
   * Spheron's offer catalogue is dynamic — there are no static rates, so
   * the resolver picks the cheapest cloudInit-capable DEDICATED offer
   * matching the template's GPU + region constraints, snapshots the
   * pricing onto the row, and hands off to `deployServiceSpheron`.
   *
   * If no offer matches (tight region filter, GPU acceptables locked
   * down, or temporary fleet starvation), throws `NO_CAPACITY` so the
   * web-app's auto-router can fall back to Akash.
   */
  deployFromTemplateToSpheron: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        templateId: string
        projectId: string
        serviceName?: string
        envOverrides?: Array<{ key: string; value: string }>
        resourceOverrides?: ResourceOverrideInput
        policy?: DeploymentPolicyInput
      }
    },
    context: Context,
  ) => {
    await assertSubscriptionActive(context.organizationId)
    if (!context.userId) throw new GraphQLError('Not authenticated')
    if (!context.organizationId) {
      throw new GraphQLError(
        'Spheron deployments require an organization context. Switch to a workspace first.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      )
    }

    const template = getTemplateById(input.templateId)
    if (!template) {
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    }

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
    })
    if (!project) throw new GraphQLError('Project not found')
    assertProjectAccess(context, project, 'Not authorized to deploy to this project')

    const serviceName =
      input.serviceName || defaultServiceNameForTemplate(template)
    const slug = generateSlug(serviceName)

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) envOverrides[key] = value
    }

    await injectPlatformEnvVars(template, envOverrides, context, slug)
    assertRequiredTemplateEnvVars(template, envOverrides)

    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
    }

    // ── Pick the offer BEFORE creating any DB rows so a NO_CAPACITY
    //    failure never leaves a stub Service behind for the auto-router ──
    const { getSpheronClient, pickSpheronOffer, NoSpheronCapacityError } =
      await import('../services/spheron/index.js')

    const client = getSpheronClient()
    if (!client) {
      throw new GraphQLError('Spheron is not configured on this server.', {
        extensions: { code: 'PROVIDER_UNAVAILABLE' },
      })
    }

    const { getCachedSpheronSshKeyId } = await import('../services/providers/spheronSshKeyBootstrap.js')
    const sshKeyId = getCachedSpheronSshKeyId()
    if (!sshKeyId) {
      throw new GraphQLError(
        'Spheron SSH key bootstrap has not completed yet. Try again in 30 seconds.',
        { extensions: { code: 'PROVIDER_UNAVAILABLE' } },
      )
    }

    const resourceOverrides = normalizeResourceOverrides(input.resourceOverrides)
    const resolved = resolveTemplateResources(template.resources, resourceOverrides)
    const requiredGpu = resolved.gpu

    let picked
    try {
      picked = await pickSpheronOffer({
        client,
        instanceType: 'DEDICATED',
        bucket: null,
        gpuConstraint: {
          gpuCount: input.policy?.gpuUnits ?? requiredGpu?.units ?? 1,
          acceptableGpuModels:
            input.policy?.acceptableGpuModels ??
            (requiredGpu?.model ? [requiredGpu.model] : []),
        },
      })
    } catch (err) {
      if (err instanceof NoSpheronCapacityError) {
        throw new GraphQLError(err.reason, {
          extensions: { code: 'NO_CAPACITY', provider: 'spheron' },
        })
      }
      throw err
    }

    // ── Pricing snapshot ─────────────────────────────────────
    const billing = getBillingApiClient()
    const orgBilling = await billing.getOrgBilling(context.organizationId)
    const orgMarkup = await billing.getOrgMarkup(orgBilling.orgBillingId)
    const rawHourlyUsd = picked.offer.price
    const chargedHourlyUsd = applyMargin(rawHourlyUsd, orgMarkup.marginRate)
    const hourlyRateCents = Math.ceil(chargedHourlyUsd * 100)
    const originalHourlyRateCents = Math.ceil(rawHourlyUsd * 100)

    const estimatedDailyCostCents = Math.max(
      BILLING_CONFIG.spheron.minBalanceCentsToLaunch,
      hourlyRateCents * 24,
    )
    await assertDeployBalance(context.organizationId, 'spheron', context.prisma, {
      dailyCostCents: estimatedDailyCostCents,
    })

    // ── Now create the Service + ports + envVars (mirror Phala flow) ─
    const service = await context.prisma.service.create({
      data: {
        name: serviceName,
        slug,
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        createdByUserId: context.userId ?? null,
        internalHostname: generateInternalHostname(slug, project.slug),
      },
    })

    if (template.envVars?.length) {
      await context.prisma.$transaction(
        template.envVars.map((ev: any) =>
          context.prisma.serviceEnvVar.create({
            data: {
              serviceId: service.id,
              key: ev.key,
              value: envOverrides[ev.key] ?? ev.default ?? '',
              secret: ev.secret ?? false,
            },
          }),
        ),
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
          }),
        ),
      )
    }

    // No companion services on Spheron — the cloudInit is a single VM.
    // Templates that declare companions (e.g. postgres sidecar) deploy
    // ALL components into the same compose YAML. Phase 2 work item if a
    // template ever genuinely needs a separate VM per companion.

    let policyId: string | undefined
    if (input.policy) {
      const policyRecord = await context.prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: input.policy.acceptableGpuModels ?? [],
          gpuUnits: input.policy.gpuUnits ?? null,
          gpuVendor: input.policy.gpuVendor ?? null,
          maxBudgetUsd: input.policy.maxBudgetUsd ?? null,
          maxMonthlyUsd: input.policy.maxMonthlyUsd ?? null,
          runtimeMinutes: input.policy.runtimeMinutes ?? null,
          expiresAt: input.policy.runtimeMinutes
            ? new Date(Date.now() + input.policy.runtimeMinutes * 60_000)
            : null,
        },
      })
      policyId = policyRecord.id
    }

    const composeContent = generateComposeFromTemplate(template, {
      serviceName: slug,
      envOverrides,
      resourceOverrides,
      target: 'spheron',
    })
    const envKeys = getEnvKeysFromTemplate(template, envOverrides)

    const mergedEnv: Record<string, string> = {}
    for (const v of template.envVars) {
      if (v.default !== null) mergedEnv[v.key] = v.default
    }
    Object.assign(mergedEnv, envOverrides)

    // UFW must open the host-side port (LEFT side of the compose
    // `host:container` mapping). For TemplatePort that's `as` (exposed
    // ingress port) — `port` is the container-internal port the app
    // listens on, which is invisible from outside the VM. e.g. milady
    // declares `{ port: 2138, as: 80 }` and the compose generator emits
    // `"80:2138"`; the VM's ip:80 is reachable, ip:2138 is not.
    const exposePorts: number[] = []
    for (const p of template.ports ?? []) {
      const hostPort = typeof p.as === 'number' && p.as > 0 ? p.as : p.port
      if (typeof hostPort === 'number' && hostPort > 0) exposePorts.push(hostPort)
    }

    const { getSpheronOrchestrator } = await import('../services/spheron/index.js')
    const orchestrator = getSpheronOrchestrator(context.prisma)

    try {
      const deploymentId = await orchestrator.deployServiceSpheron(service.id, {
        provider: picked.offer.provider,
        offerId: picked.offer.offerId,
        gpuType: picked.group.gpuType,
        gpuCount: picked.offer.gpuCount,
        region: picked.region,
        operatingSystem: picked.operatingSystem,
        instanceType: 'DEDICATED',
        hourlyRateCents,
        originalHourlyRateCents,
        marginRate: orgMarkup.marginRate,
        pricedSnapshotJson: picked.offer as unknown,
        sshKeyId,
        composeContent,
        envVars: mergedEnv,
        exposePorts,
        orgBillingId: orgBilling.orgBillingId,
        organizationId: context.organizationId,
        policyId,
      })

      const { isQStashEnabled, publishJob } = await import('../services/queue/qstashClient.js')
      if (isQStashEnabled()) {
        await publishJob(
          '/queue/spheron/step',
          { step: 'POLL_STATUS', deploymentId, attempt: 1 },
          { delaySec: 5 },
        )
      } else {
        const { handleSpheronStep } = await import('../services/queue/webhookHandler.js')
        handleSpheronStep({ step: 'POLL_STATUS', deploymentId, attempt: 1 } as never).catch(err => {
          log.error({ err, deploymentId }, 'In-process Spheron POLL_STATUS dispatch failed')
        })
      }

      log.info(
        { deploymentId, envKeyCount: envKeys.length, provider: picked.offer.provider, region: picked.region },
        'Started Spheron template deployment',
      )

      const deployment = await context.prisma.spheronDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
      })
      if (!deployment) {
        throw new GraphQLError('Spheron deployment record not found after creation')
      }
      return deployment
    } catch (error: any) {
      throw new GraphQLError(
        `Spheron deployment failed: ${error?.message || 'Unknown error'}`,
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
        primaryServiceId?: string
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
        enabledComponentIds?: string[]
        componentFallbackOverrides?: Record<string, Record<string, string>>
        serviceName?: string
        envOverrides?: Array<{ key: string; value: string }>
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
        policy?: DeploymentPolicyInput
      }
    },
    context: Context
  ) => {
    await assertSubscriptionActive(context.organizationId)
    {
      const hasGpu = !!(input.resourceOverrides?.gpu?.units || input.policy?.gpuUnits)
      const gpuUnits = input.resourceOverrides?.gpu?.units ?? input.policy?.gpuUnits ?? 0
      const compositeCost = hasGpu
        ? BILLING_CONFIG.thresholds.failClosedAboveCentsPerDay * gpuUnits
        : BILLING_CONFIG.akash.minBalanceCentsToLaunch
      await assertDeployBalance(context.organizationId, 'akash', context.prisma, {
        dailyCostCents: compositeCost,
      })
    }
    if (!context.userId) throw new GraphQLError('Not authenticated')

    // ── Validate policy input if provided ────────────────────
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
    }

    const template = getTemplateById(input.templateId)
    if (!template)
      throw new GraphQLError(`Template not found: ${input.templateId}`)
    if (!template.components?.length)
      throw new GraphQLError('Template has no components')

    // Filter components by enabledComponentIds (if provided)
    const enabledSet = input.enabledComponentIds
      ? new Set(input.enabledComponentIds)
      : null

    const isComponentRequired = (comp: (typeof template.components)[0]) =>
      comp.primary || comp.internalOnly || comp.required !== false

    // Validate that all required components are enabled
    if (enabledSet) {
      for (const comp of template.components) {
        if (isComponentRequired(comp) && !enabledSet.has(comp.id)) {
          throw new GraphQLError(
            `Component '${comp.name}' (${comp.id}) is required and cannot be disabled`
          )
        }
      }
    }

    const enabledComponents = enabledSet
      ? template.components.filter(c => enabledSet.has(c.id))
      : template.components

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
      for (const comp of enabledComponents) {
        targets.push({ componentId: comp.id, provider: prov, group: 'main' })
      }
    } else {
      if (!input.componentTargets?.length) {
        throw new GraphQLError('Custom mode requires componentTargets')
      }
      let akashCounter = 0
      let phalaCounter = 0
      for (const ct of input.componentTargets) {
        if (enabledSet && !enabledSet.has(ct.componentId)) continue
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
    assertProjectAccess(context, project, 'Not authorized to deploy to this project')

    const existingPrimaryService = input.primaryServiceId
      ? await context.prisma.service.findUnique({
          where: { id: input.primaryServiceId },
        })
      : null
    if (input.primaryServiceId && !existingPrimaryService) {
      throw new GraphQLError('Primary service not found')
    }
    if (
      existingPrimaryService &&
      existingPrimaryService.projectId !== input.projectId
    ) {
      throw new GraphQLError('Primary service does not belong to this project')
    }

    const envOverrides: Record<string, string> = {}
    if (input.envOverrides) {
      for (const { key, value } of input.envOverrides) envOverrides[key] = value
    }

    const baseName =
      input.serviceName ||
      existingPrimaryService?.name ||
      defaultServiceNameForTemplate(template)
    const generatedPrimarySlug = generateSlug(baseName)

    // ── Auto-inject platform env vars (AF_ORG_ID, AF_API_KEY) ─
    await injectPlatformEnvVars(
      template,
      envOverrides,
      context,
      generatedPrimarySlug
    )
    assertRequiredTemplateEnvVars(template, envOverrides)

    // ── Resolve components ──────────────────────────────────────
    const activeComponentIds = new Set(targets.map(t => t.componentId))
    const activeComponents = template.components.filter(c =>
      activeComponentIds.has(c.id)
    )

    const password = generatePassword()
    const secret = generateBase64Secret()

    const slugs: Record<string, string> = {}
    const groups: Record<string, string> = {}
    const providers: Record<string, 'akash' | 'phala'> = {}
    for (const target of targets) {
      const comp = activeComponents.find(c => c.id === target.componentId)
      if (!comp) continue
      if (comp.primary) {
        slugs[comp.id] = generatedPrimarySlug
      } else {
        slugs[comp.id] = generateSlug(`${baseName}-${comp.id}`)
      }
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

    // Build fallback map for disabled components, merging user overrides
    const componentFallbacks: Record<string, Record<string, string>> = {}
    const userFallbackOverrides = input.componentFallbackOverrides as
      | Record<string, Record<string, string>>
      | undefined
    if (enabledSet) {
      for (const comp of template.components) {
        if (!enabledSet.has(comp.id)) {
          componentFallbacks[comp.id] = {
            ...(comp.fallbacks || {}),
            ...(userFallbackOverrides?.[comp.id] || {}),
          }
        }
      }
    }

    const ctx: CompositeContext = {
      slugs,
      groups,
      providers,
      password,
      secret,
      componentFallbacks,
    }

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

    const primaryService = await upsertCompositeServiceRecord(
      context.prisma,
      existingPrimaryService?.id,
      {
        name: baseName,
        slug: slugs[primaryComp.id],
        type: template.serviceType,
        projectId: input.projectId,
        templateId: input.templateId,
        createdByUserId: context.userId ?? null,
        internalHostname: generateInternalHostname(
          slugs[primaryComp.id],
          project.slug
        ),
        sdlServiceName: primaryComp.sdlServiceName,
        parentServiceId: null,
      }
    )

    const existingChildServices = input.primaryServiceId
      ? await context.prisma.service.findMany({
          where: {
            parentServiceId: primaryService.id,
          },
        })
      : []

    const existingChildByComponent = new Map<string, (typeof existingChildServices)[number]>(
      existingChildServices.map(service => [
        service.sdlServiceName ?? service.slug,
        service,
      ])
    )

    const serviceIds: Record<string, string> = {
      [primaryComp.id]: primaryService.id,
    }

    for (const comp of resolved) {
      if (comp.id === primaryComp.id) continue
      const compDef = activeComponents.find(c => c.id === comp.id)!
      const componentLookupKey = comp.sdlServiceName ?? slugs[comp.id]
      const existingChild =
        existingChildByComponent.get(componentLookupKey) ??
        existingChildByComponent.get(slugs[comp.id])

      const svc = await upsertCompositeServiceRecord(
        context.prisma,
        existingChild?.id,
        {
          name: `${baseName}-${comp.id}`,
          slug: slugs[comp.id],
          type: compDef.templateId
            ? (getTemplateById(compDef.templateId)?.serviceType ?? 'VM')
            : template.serviceType,
          projectId: input.projectId,
          templateId: compDef.templateId ?? input.templateId,
          createdByUserId: context.userId ?? null,
          internalHostname: generateInternalHostname(
            slugs[comp.id],
            project.slug
          ),
          parentServiceId: primaryService.id,
          sdlServiceName: comp.sdlServiceName,
        }
      )
      serviceIds[comp.id] = svc.id
    }

    // Persist env vars and ports for each service
    for (const comp of resolved) {
      const svcId = serviceIds[comp.id]
      const envEntries = Object.entries(comp.resolvedEnv)
      await replaceCompositeServiceConfig(
        context.prisma,
        svcId,
        envEntries,
        comp.ports
      )
    }

    // ── Helper: create a policy record for each sub-deployment ─
    async function createPolicyForComponent(): Promise<string | undefined> {
      if (!input.policy) return undefined
      const record = await context.prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: input.policy.acceptableGpuModels ?? [],
          gpuUnits: input.policy.gpuUnits ?? null,
          gpuVendor: input.policy.gpuVendor ?? null,
          maxBudgetUsd: input.policy.maxBudgetUsd ?? null,
          maxMonthlyUsd: input.policy.maxMonthlyUsd ?? null,
          runtimeMinutes: input.policy.runtimeMinutes ?? null,
          expiresAt: input.policy.runtimeMinutes
            ? new Date(Date.now() + input.policy.runtimeMinutes * 60_000)
            : null,
        },
      })
      return record.id
    }

    // ── Deploy Akash groups ─────────────────────────────────────
    const failedComponents: Array<{ componentId: string; componentName: string; error: string }> = []
    const succeededComponents: string[] = []

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
        const deploymentId = await orchestrator.deployService(deployServiceId, {
          sdlContent,
          skipEnvInjection: true,
        })

        const compositePolicyId = await createPolicyForComponent()
        if (compositePolicyId) {
          await context.prisma.akashDeployment.update({
            where: { id: deploymentId },
            data: { policyId: compositePolicyId },
          })
        }

        for (const gc of groupComponents) succeededComponents.push(gc.id)
      } catch (error: any) {
        const msg = error.message || 'Unknown error'
        log.error({ groupName, error: msg }, 'Akash group deploy failed')
        for (const gc of groupComponents) {
          const compDef = activeComponents.find(c => c.id === gc.id)
          failedComponents.push({
            componentId: gc.id,
            componentName: compDef?.name ?? gc.id,
            error: `Akash: ${msg}`,
          })
        }
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
        const phalaInstance = await resolvePhalaInstanceType(
          comp.resources,
          input.policy?.acceptableGpuModels,
          input.policy?.gpuUnits
        )
        const deploymentId = await orchestrator.deployServicePhala(svcId, {
          composeContent,
          env: comp.resolvedEnv,
          envKeys,
          name: `af-${slugs[comp.id]}-${Date.now().toString(36)}`,
          cvmSize: phalaInstance.cvmSize,
          gpuModel: phalaInstance.gpuModel ?? undefined,
          hourlyRateUsd: phalaInstance.hourlyRateUsd,
        })

        const compositePolicyId = await createPolicyForComponent()
        if (compositePolicyId) {
          await context.prisma.phalaDeployment.update({
            where: { id: deploymentId },
            data: { policyId: compositePolicyId },
          })
        }

        succeededComponents.push(comp.id)
      } catch (error: any) {
        const msg = error.message || 'Unknown error'
        log.error({ componentId: comp.id, error: msg }, 'Phala component deploy failed')
        const compDef = activeComponents.find(c => c.id === comp.id)
        failedComponents.push({
          componentId: comp.id,
          componentName: compDef?.name ?? comp.id,
          error: `Phala: ${msg}`,
        })
      }
    }

    if (failedComponents.length > 0 && succeededComponents.length === 0) {
      throw new GraphQLError(
        `All composite deployments failed: ${failedComponents.map(f => `${f.componentName}: ${f.error}`).join('; ')}`
      )
    }

    return {
      primaryServiceId: primaryService.id,
      partialSuccess: failedComponents.length > 0,
      failedComponents: failedComponents.length > 0 ? failedComponents : null,
      succeededComponents: succeededComponents.length > 0 ? succeededComponents : null,
    }
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
      env[v.key] = v.default ?? ''
    }
    if (parentTemplate.akash) {
      const a = parentTemplate.akash
      if (a.chownPaths?.length)
        env['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
      if (a.runUser) env['AKASH_RUN_USER'] = a.runUser
      if (a.runUid !== undefined && a.runUid !== null) {
        env['AKASH_RUN_UID'] = String(a.runUid)
      }
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
      env[v.key] = v.default ?? ''
    }
    if (comp.envDefaults) {
      for (const [k, v] of Object.entries(comp.envDefaults)) env[k] = v
    }
    if (ref.akash) {
      const a = ref.akash
      if (a.chownPaths?.length)
        env['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
      if (a.runUser) env['AKASH_RUN_USER'] = a.runUser
      if (a.runUid !== undefined && a.runUid !== null) {
        env['AKASH_RUN_UID'] = String(a.runUid)
      }
    }
    const isPostgres =
      comp.templateId === 'postgres' ||
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
      env[v.key] = v.default ?? ''
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
  Template: {
    releaseStage: (parent: Template) => parent.releaseStage ?? 'production',
  },
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
