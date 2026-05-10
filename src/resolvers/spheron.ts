/**
 * Spheron Deployment Resolvers
 *
 * GraphQL surface for Spheron-provisioned GPU VMs. Spheron has no native
 * stop — `deleteSpheronDeployment` is the user-final action; pause/resume
 * is automatic via the low-balance scheduler.
 *
 * Mirrors `phala.ts` structurally:
 *   - queries: spheronDeployment / spheronDeployments / spheronDeploymentByService / spheronGpuOffers
 *   - field resolvers: cost grid + activeSince + relations
 *   - mutations: deployToSpheron (resolver auto-picks the cheapest offer
 *     from the live catalog) + deleteSpheronDeployment
 *
 * `deployFromTemplateToSpheron` lives in `templates.ts` next to its
 * Akash/Phala siblings (so the template-resource helpers stay co-located).
 */

import { GraphQLError } from 'graphql'

import {
  getSpheronClient,
  getSpheronOrchestrator,
  pickSpheronOffer,
  NoSpheronCapacityError,
  type DeployServiceSpheronOptions,
} from '../services/spheron/index.js'
import { parseServiceVolumes } from '../services/akash/orchestrator.js'
import { getCachedSpheronSshKeyId } from '../services/providers/spheronSshKeyBootstrap.js'
import { processFinalSpheronBilling } from '../services/billing/deploymentSettlement.js'
import { decrementOrgConcurrency } from '../services/concurrency/concurrencyService.js'
import { applyMargin } from '../config/pricing.js'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import { BILLING_CONFIG } from '../config/billing.js'
import { assertSubscriptionActive } from './subscriptionCheck.js'
import {
  assertDeployBalance,
  checkTimeLimitedDeployBalance,
} from './balanceCheck.js'
import { assertLaunchAllowed } from './launchGuards.js'
import { validatePolicyInput } from '../services/policy/validator.js'
import type { DeploymentPolicyInput } from '../services/policy/types.js'
import {
  getTemplateById,
  generateComposeFromTemplate,
  generateComposeFromService,
  getEnvKeysFromTemplate,
} from '../templates/index.js'
import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { createLogger } from '../lib/logger.js'
import { audit } from '../lib/audit.js'
import { resolveSpheronActiveSince } from '../lib/leaseChain.js'

const log = createLogger('resolver-spheron')

const SPHERON_ALREADY_GONE_REGEX =
  /not found|does not exist|already stopped|already deleted|no such|404/i

// ─── Queries ─────────────────────────────────────────────────────────

export const spheronQueries = {
  spheronDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context,
  ) => {
    requireAuth(context)
    const deployment = await context.prisma.spheronDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } }, site: true, afFunction: true },
    })
    if (!deployment) throw new GraphQLError('Spheron deployment not found')
    assertProjectAccess(context, deployment.service.project)
    return deployment
  },

  spheronDeployments: async (
    _: unknown,
    { serviceId, projectId }: { serviceId?: string; projectId?: string },
    context: Context,
  ) => {
    requireAuth(context)

    if (serviceId) {
      const service = await context.prisma.service.findUnique({
        where: { id: serviceId },
        include: { project: true },
      })
      if (!service?.project) throw new GraphQLError('Service or project not found')
      assertProjectAccess(context, service.project)
    }
    if (projectId) {
      const project = await context.prisma.project.findUnique({ where: { id: projectId } })
      if (!project) throw new GraphQLError('Project not found')
      assertProjectAccess(context, project)
    }

    const where: Record<string, unknown> = {}
    if (serviceId) where.serviceId = serviceId
    if (projectId) where.service = { projectId } as any

    return context.prisma.spheronDeployment.findMany({
      where,
      include: { service: true },
      orderBy: { createdAt: 'desc' },
    })
  },

  spheronDeploymentByService: async (
    _: unknown,
    { serviceId }: { serviceId: string },
    context: Context,
  ) => {
    requireAuth(context)
    const service = await context.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: true },
    })
    if (!service?.project) throw new GraphQLError('Service or project not found')
    assertProjectAccess(context, service.project)

    return context.prisma.spheronDeployment.findFirst({
      where: { serviceId, status: { in: ['CREATING', 'STARTING', 'ACTIVE'] } },
      include: { service: true },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * Live Spheron GPU offer catalog. Public — no auth required (mirrors
   * Spheron's own /api/gpu-offers which is unauthenticated). Defaults to
   * filtering on `supportsCloudInit: true` since our bring-up requires it.
   */
  spheronGpuOffers: async (
    _: unknown,
    { filters }: { filters?: {
      page?: number
      limit?: number
      search?: string
      sortBy?: string
      sortOrder?: string
      instanceType?: string
      cloudInitOnly?: boolean
    } },
  ) => {
    const client = getSpheronClient()
    if (!client) {
      throw new GraphQLError(
        'Spheron is not configured on this server. Set SPHERON_API_KEY to enable GPU VM deployments.',
        { extensions: { code: 'PROVIDER_UNAVAILABLE' } },
      )
    }

    const sortBy = (filters?.sortBy as 'lowestPrice' | 'highestPrice' | 'averagePrice' | undefined) ?? undefined
    const sortOrder = (filters?.sortOrder as 'asc' | 'desc' | undefined) ?? undefined
    const instanceType = (filters?.instanceType as 'SPOT' | 'DEDICATED' | 'CLUSTER' | undefined) ?? undefined

    const response = await client.listGpuOffers({
      page: filters?.page,
      limit: filters?.limit,
      search: filters?.search,
      sortBy,
      sortOrder,
      instanceType,
    })

    const cloudInitOnly = filters?.cloudInitOnly ?? true
    const filtered = cloudInitOnly
      ? response.data
          .map(group => ({
            ...group,
            offers: group.offers.filter(o => o.supportsCloudInit && o.available),
          }))
          .filter(group => group.offers.length > 0)
      : response.data

    return {
      data: filtered.map(group => ({
        gpuType: group.gpuType,
        gpuModel: group.gpuModel,
        displayName: group.displayName,
        totalAvailable: group.totalAvailable,
        lowestPrice: group.lowestPrice,
        highestPrice: group.highestPrice,
        averagePrice: group.averagePrice,
        providers: group.providers,
        offers: group.offers.map(o => ({
          provider: o.provider,
          offerId: o.offerId,
          name: o.name,
          description: o.description ?? null,
          vcpus: o.vcpus,
          memory: o.memory,
          storage: o.storage,
          gpuCount: o.gpuCount,
          price: o.price,
          spotPrice: o.spot_price ?? null,
          available: o.available,
          clusters: o.clusters,
          gpuMemory: o.gpu_memory,
          osOptions: o.os_options,
          interconnectType: o.interconnectType ?? null,
          instanceType: o.instanceType,
          supportsCloudInit: o.supportsCloudInit,
        })),
      })),
      total: response.total,
      page: response.page,
      limit: response.limit,
      totalPages: response.totalPages,
    }
  },
}

// ─── Field Resolvers ─────────────────────────────────────────────────

export const spheronFieldResolvers = {
  SpheronDeployment: {
    costPerHour: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return parent.hourlyRateCents / 100
    },
    costPerDay: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return (parent.hourlyRateCents / 100) * 24
    },
    costPerMonth: (parent: any) => {
      if (parent.hourlyRateCents == null) return null
      return (parent.hourlyRateCents / 100) * 24 * 30
    },
    service: async (parent: any, _: unknown, context: Context) => {
      return context.prisma.service.findUnique({ where: { id: parent.serviceId } })
    },
    site: async (parent: any, _: unknown, context: Context) => {
      if (!parent.siteId) return null
      return context.prisma.site.findUnique({ where: { id: parent.siteId } })
    },
    afFunction: async (parent: any, _: unknown, context: Context) => {
      if (!parent.afFunctionId) return null
      return context.prisma.aFFunction.findUnique({ where: { id: parent.afFunctionId } })
    },
    policy: async (parent: any, _: unknown, context: Context) => {
      if (parent.policy) return parent.policy
      if (!parent.policyId) return null
      return context.prisma.deploymentPolicy.findUnique({ where: { id: parent.policyId } })
    },
    activeSince: async (parent: any, _: unknown, context: Context) => {
      const earliest = await resolveSpheronActiveSince(context.prisma, parent.id)
      return earliest ?? parent.activeStartedAt ?? null
    },
  },
  Service: {
    spheronDeployments: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      return context.prisma.spheronDeployment.findMany({
        where: { serviceId },
        orderBy: { createdAt: 'desc' },
      })
    },
    activeSpheronDeployment: async (parent: any, _: unknown, context: Context) => {
      const serviceId = parent.parentServiceId || parent.id
      return context.prisma.spheronDeployment.findFirst({
        where: {
          serviceId,
          status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
  },
}

// ─── Mutations ───────────────────────────────────────────────────────

export const spheronMutations = {
  /**
   * Deploy an existing service to Spheron. Mirrors `deployToPhala` shape;
   * the resolver auto-picks the cheapest cloudInit-capable DEDICATED offer
   * matching the service's GPU + region constraints.
   *
   * Power-users can force a specific offer via `input.offerId` (and
   * optionally `input.provider`).
   *
   * No `stopSpheronDeployment` exists — Spheron has no native stop. The
   * resolver intentionally does NOT auto-route to Akash on Spheron capacity
   * failure: that decision lives in the web-app's
   * `services/templates/actions.ts` per Phase D.
   */
  deployToSpheron: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        serviceId: string
        policy?: DeploymentPolicyInput
        resourceOverrides?: {
          cpu?: number
          memory?: string
          storage?: string
          gpu?: { units: number; vendor: string; model?: string } | null
        }
        baseImage?: string
        region?: string
        offerId?: string
        provider?: string
      }
    },
    context: Context,
  ) => {
    if (!context.userId) throw new GraphQLError('Not authenticated')

    const subscriptionStatus = await assertSubscriptionActive(context.organizationId)

    const service = await context.prisma.service.findUnique({
      where: { id: input.serviceId },
      include: {
        project: true,
        afFunction: true,
        site: true,
        envVars: true,
        ports: true,
      },
    })
    if (!service) throw new GraphQLError('Service not found')
    assertProjectAccess(context, service.project, 'Not authorized to deploy this service')

    // ── Service-type guard ───────────────────────────────────────────
    // Spheron currently supports VM / SITE / DATABASE / CRON via raw
    // Docker compose, plus any template-backed service. FUNCTION needs
    // a runtime wrapper (oven/bun:1.1-alpine + base64 source injection,
    // see akash/orchestrator.ts:generateFunctionSDL) that the compose
    // generator doesn't emit yet — silently deploying would leave the
    // function code unreachable. BUCKET is rustfs-only on Akash today.
    // Fail fast with a clear message instead of producing a broken VM.
    if (service.type === 'FUNCTION') {
      throw new GraphQLError(
        'FUNCTION services are not yet supported on Spheron. Use Standard (Akash) for serverless functions, or convert this to a VM/SITE service.',
        { extensions: { code: 'PROVIDER_UNSUPPORTED', serviceType: service.type } },
      )
    }
    if (service.type === 'BUCKET') {
      throw new GraphQLError(
        'BUCKET services (rustfs / S3-compatible storage) only run on Akash today.',
        { extensions: { code: 'PROVIDER_UNSUPPORTED', serviceType: service.type } },
      )
    }

    // ── CPU-only guard ───────────────────────────────────────────────
    // Spheron is a GPU-first cloud — `client.listGpuOffers` is the only
    // listing API and there is no CPU-only catalog. If the user
    // explicitly disabled GPU in the deploy form (`resourceOverrides.gpu
    // === null`), throw `NO_CAPACITY` rather than silently allocating a
    // GPU they didn't ask for. The web-app auto-router (`actions.ts ::
    // deployServiceAutoRouted`) catches `NO_CAPACITY` and falls back to
    // Akash, which does support CPU-only workloads — so the user lands
    // on a working provider without ever seeing this error in the UI.
    if (input.resourceOverrides?.gpu === null) {
      throw new GraphQLError(
        'Spheron is GPU-only — falling back to Akash for CPU-only workloads.',
        {
          extensions: {
            code: 'NO_CAPACITY',
            provider: 'spheron',
            reason: 'cpu_only_requested',
          },
        },
      )
    }

    const sshKeyId = getCachedSpheronSshKeyId()
    if (!sshKeyId) {
      throw new GraphQLError(
        'Spheron SSH key bootstrap has not completed yet. Try again in 30 seconds, or check the cloud-api logs.',
        { extensions: { code: 'PROVIDER_UNAVAILABLE' } },
      )
    }

    if (!context.organizationId) {
      throw new GraphQLError(
        'Spheron deployments require an organization context. Switch to a workspace first.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      )
    }

    const client = getSpheronClient()
    if (!client) {
      throw new GraphQLError(
        'Spheron is not configured on this server.',
        { extensions: { code: 'PROVIDER_UNAVAILABLE' } },
      )
    }

    // ── Resolve policy validation up-front (defer DB write until after offer pick) ──
    if (input.policy) {
      const validation = validatePolicyInput(input.policy)
      if (!validation.allowed) {
        throw new GraphQLError(validation.reason ?? 'Invalid deployment policy')
      }
    }

    // ── Pick the offer ────────────────────────────────────────
    let picked
    try {
      // Build the GPU constraint from BOTH `policy.acceptableGpuModels` AND
      // `resourceOverrides.gpu.model`. The web-app's compute panel writes
      // the model into `resourceOverrides` (always), but only writes it
      // into `policy.acceptableGpuModels` when the user used the multi-
      // select surface (legacy single-select skipped it pre-fix). Without
      // this fallback, a user who picks "RTX A6000" via the legacy
      // dropdown gets "any GPU is fine" semantics and the picker happily
      // returns the cheapest A4000.
      const acceptableGpuModels = input.policy?.acceptableGpuModels?.length
        ? input.policy.acceptableGpuModels
        : input.resourceOverrides?.gpu?.model
          ? [input.resourceOverrides.gpu.model]
          : undefined
      picked = await pickSpheronOffer({
        client,
        instanceType: 'DEDICATED',
        bucket: input.region ?? null,
        gpuConstraint: {
          gpuCount: input.policy?.gpuUnits ?? input.resourceOverrides?.gpu?.units ?? 1,
          acceptableGpuModels,
        },
        offerIdOverride: input.offerId,
        providerOverride: input.provider,
      })
    } catch (err) {
      if (err instanceof NoSpheronCapacityError) {
        throw new GraphQLError(err.reason, {
          extensions: { code: 'NO_CAPACITY', provider: 'spheron' },
        })
      }
      throw err
    }

    // ── Resolve template / compose ────────────────────────────
    const template = service.templateId ? getTemplateById(service.templateId) : null
    const envOverrides: Record<string, string> = {}
    for (const ev of service.envVars) envOverrides[ev.key] = ev.value

    let composeContent: string
    let envKeys: string[]
    let mergedEnv: Record<string, string> = {}

    if (template) {
      composeContent = generateComposeFromTemplate(template, {
        serviceName: service.slug,
        envOverrides,
        target: 'spheron',
      })
      envKeys = getEnvKeysFromTemplate(template, envOverrides)
      for (const v of template.envVars) mergedEnv[v.key] = v.default ?? ''
      Object.assign(mergedEnv, envOverrides)
    } else {
      const dockerImage = service.dockerImage || input.baseImage || 'ubuntu:24.04'
      // Determine whether the container needs an external keep-alive command.
      // Rules (Spheron-specific):
      //   1. If the user provided an explicit startCommand, always honour it.
      //   2. Otherwise, if the service is a `VM` (raw OS image like
      //      ubuntu:24.04), inject `sleep infinity` — bare base images run
      //      `bash` as default CMD and exit immediately, leaving the VM
      //      with zero containers and our cloud-init probe waiting forever.
      //   3. Otherwise (DATABASE/SITE/FUNCTION/etc.), trust the image's
      //      own CMD — those are daemon images (postgres, nginx, etc.).
      // Also, drop `dockerImage` heuristic from the previous version: it
      // was wrong because the web-app sets `service.dockerImage` even for
      // bare VM flavors, which made `needsKeepAlive` always false.
      const startCommand = service.startCommand
        ? service.startCommand
        : service.type === 'VM'
          ? 'sleep infinity'
          : undefined
      const isGithubBuild = service.flavor === 'github' || !!service.gitProvider
      const parsedVolumes = parseServiceVolumes(service.volumes)
      composeContent = generateComposeFromService({
        dockerImage,
        ports: service.ports,
        envVars: service.envVars.map(ev => ({ key: ev.key, value: ev.value })),
        startCommand,
        containerPort: service.containerPort,
        isGithubBuild,
        volumes: parsedVolumes,
        target: 'spheron',
      })
      envKeys = service.envVars.map(ev => ev.key)
      mergedEnv = { ...envOverrides }
    }

    // ── Resolve UFW expose ports ──────────────────────────────
    // The subdomain proxy targets http://<ipAddress>:<HOST_PORT>, where the
    // host port is the LEFT side of docker-compose's `host:container`
    // mapping (see `generateComposeFromService`). UFW must open the same
    // host port — opening the container-internal port would expose nothing
    // because Docker only binds the host side to 0.0.0.0.
    //
    // Priority:
    //   1. For each service.ports row: prefer publicPort (explicit host
    //      bind), fall back to containerPort (compose emits 1:1 mapping
    //      when publicPort is null)
    //   2. Service.containerPort fallback (1:1 mapping)
    //   3. github-source build → 3000 (Next/Nuxt/Bun default)
    //   4. plain default → 80
    // Without (3)/(4) a github-built service with no explicit port would
    // open zero firewall ports and the proxy would 502 forever.
    const exposePorts: number[] = []
    for (const p of service.ports) {
      const hostPort = p.publicPort ?? p.containerPort
      if (hostPort > 0) exposePorts.push(hostPort)
    }
    if (exposePorts.length === 0 && service.containerPort) {
      exposePorts.push(service.containerPort)
    }
    if (exposePorts.length === 0) {
      const isGithubBuild = service.flavor === 'github' || !!service.gitProvider
      exposePorts.push(isGithubBuild ? 3000 : 80)
    }

    // ── Pricing snapshot + billing ────────────────────────────
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

    // ── Time-limited reservation (if policy specifies runtimeMinutes) ──
    let reservedCents = 0
    if (input.policy?.runtimeMinutes && input.policy.runtimeMinutes > 0) {
      const requestedHours = input.policy.runtimeMinutes / 60
      const check = await checkTimeLimitedDeployBalance(
        context.organizationId,
        'spheron',
        context.prisma,
        hourlyRateCents,
        requestedHours,
      )
      if (!check.allowed) {
        throw new GraphQLError(
          check.reason ?? 'Insufficient balance for time-limited deployment.',
          {
            extensions: {
              code: 'INSUFFICIENT_BALANCE',
              maxAffordableHours: check.maxAffordableHours,
              reservationCents: check.reservationCents,
              effectiveBalanceCents: check.effectiveBalanceCents,
            },
          },
        )
      }
      reservedCents = check.reservationCents
    }

    // ── Create policy row (deferred until cost is known) ──────
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
          reservedCents,
        },
      })
      policyId = policyRecord.id
    }

    await assertLaunchAllowed(
      context.organizationId,
      context.prisma,
      estimatedDailyCostCents / 24,
      subscriptionStatus,
    )

    await assertDeployBalance(context.organizationId, 'spheron', context.prisma, {
      dailyCostCents: estimatedDailyCostCents,
    })

    // ── Audit + deploy ────────────────────────────────────────
    audit(context.prisma, {
      category: 'deployment',
      action: 'deployment.requested',
      status: 'ok',
      userId: context.userId,
      orgId: context.organizationId,
      projectId: service.project.id,
      serviceId: service.id,
      payload: {
        provider: 'spheron',
        upstreamProvider: picked.offer.provider,
        offerId: picked.offer.offerId,
        gpuType: picked.group.gpuType,
        gpuCount: picked.offer.gpuCount,
        region: picked.region,
        hourlyRateCents,
        originalHourlyRateCents,
        marginRate: orgMarkup.marginRate,
        isTemplate: !!template,
      },
    })

    log.info(
      {
        serviceId: service.id,
        provider: picked.offer.provider,
        offerId: picked.offer.offerId,
        region: picked.region,
        hourlyRateCents,
      },
      'Starting Spheron deployment',
    )

    const orchestrator = getSpheronOrchestrator(context.prisma)

    try {
      const deployServiceOpts: DeployServiceSpheronOptions = {
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
      }

      const deploymentId = await orchestrator.deployServiceSpheron(service.id, deployServiceOpts)

      // Enqueue POLL_STATUS so the QStash pipeline starts polling for the
      // upstream `running` + ipAddress transition. The orchestrator already
      // POSTed and persisted providerDeploymentId synchronously, so we go
      // straight to POLL_STATUS (DEPLOY_VM is idempotent on re-entry but
      // skipping it saves one round-trip on the happy path).
      const { isQStashEnabled, publishJob } = await import('../services/queue/qstashClient.js')
      if (isQStashEnabled()) {
        await publishJob(
          '/queue/spheron/step',
          { step: 'POLL_STATUS', deploymentId, attempt: 1 },
          { delaySec: 5 },
        )
      } else {
        const { handleSpheronStep } = await import('../services/queue/webhookHandler.js')
        // Fire-and-forget in dev; production uses QStash.
        handleSpheronStep({ step: 'POLL_STATUS', deploymentId, attempt: 1 } as never).catch(err => {
          log.error({ err, deploymentId }, 'In-process Spheron POLL_STATUS dispatch failed')
        })
      }

      const deployment = await context.prisma.spheronDeployment.findUnique({
        where: { id: deploymentId },
        include: { policy: true },
      })
      if (!deployment) throw new GraphQLError('Spheron deployment record not found after creation')
      return deployment
    } catch (error: any) {
      const msg = error?.message || 'Unknown error'
      audit(context.prisma, {
        category: 'deployment',
        action: 'deployment.submit_failed',
        status: 'error',
        userId: context.userId,
        orgId: context.organizationId,
        projectId: service.project.id,
        serviceId: service.id,
        errorMessage: msg,
        payload: {
          provider: 'spheron',
          upstreamProvider: picked.offer.provider,
          offerId: picked.offer.offerId,
          region: picked.region,
        },
      })
      if (error instanceof GraphQLError) throw error
      throw new GraphQLError(`Spheron deployment failed: ${msg}`)
    }
  },

  /**
   * Delete a Spheron deployment. Spheron has no native stop, so this is the
   * only user-facing termination action. Settles billing first, then DELETEs
   * upstream (or defers to the staleDeploymentSweeper retry pass when the
   * 20-min minimum-runtime floor blocks the upstream DELETE).
   */
  deleteSpheronDeployment: async (
    _: unknown,
    { id }: { id: string },
    context: Context,
  ) => {
    requireAuth(context)

    const deployment = await context.prisma.spheronDeployment.findUnique({
      where: { id },
      include: { service: { include: { project: true } } },
    })
    if (!deployment) throw new GraphQLError('Spheron deployment not found')
    assertProjectAccess(context, deployment.service.project, 'Not authorized to delete this deployment')

    const deletedAt = new Date()

    if (deployment.status === 'ACTIVE') {
      await processFinalSpheronBilling(
        context.prisma,
        deployment.id,
        deletedAt,
        'spheron_manual_delete',
      )
    }

    let upstreamDeleted = false
    let deferredFloorReason: string | null = null
    if (deployment.providerDeploymentId) {
      try {
        const orchestrator = getSpheronOrchestrator(context.prisma)
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
        upstreamDeleted = true
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        // Spheron's 20-min minimum-runtime floor surfaces as a 400 with a
        // `canTerminate:false, timeRemaining:N` payload (handled inline by
        // SpheronApiError.isMinimumRuntimeNotMet on the orchestrator). When
        // that fires we still mark DELETED locally; the sweeper retries the
        // upstream DELETE once the floor expires.
        const { SpheronApiError } = await import('../services/spheron/client.js')
        if (error instanceof SpheronApiError && (error as any).isMinimumRuntimeNotMet?.()) {
          deferredFloorReason = errMsg
          log.warn(
            { providerDeploymentId: deployment.providerDeploymentId, err: errMsg },
            'Spheron 20-min floor blocked DELETE — deferring upstream cleanup to sweeper',
          )
        } else if (SPHERON_ALREADY_GONE_REGEX.test(errMsg)) {
          upstreamDeleted = true
          log.warn(
            { providerDeploymentId: deployment.providerDeploymentId, err: errMsg },
            'Spheron deployment already gone — proceeding to mark DELETED in DB',
          )
        } else {
          throw new GraphQLError(`Failed to delete Spheron VM: ${errMsg}`)
        }
      }
    }

    const updated = await context.prisma.spheronDeployment.update({
      where: { id },
      data: {
        status: 'DELETED',
        upstreamDeletedAt: upstreamDeleted ? deletedAt : null,
      },
      include: { service: true },
    })

    if (deployment.policyId) {
      await context.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: deletedAt, reservedCents: 0 },
      })
    }

    if (deployment.organizationId) {
      await decrementOrgConcurrency(context.prisma, deployment.organizationId).catch(err => {
        log.warn({ err, deploymentId: id }, 'Concurrency decrement failed (Spheron manual delete)')
      })
    }

    audit(context.prisma, {
      category: 'deployment',
      action: 'lease.closed',
      status: 'ok',
      userId: context.userId,
      orgId: context.organizationId ?? undefined,
      projectId: deployment.service.project.id,
      serviceId: deployment.serviceId,
      deploymentId: deployment.id,
      payload: {
        provider: 'spheron',
        reason: 'manual_delete',
        providerDeploymentId: deployment.providerDeploymentId,
        upstreamDeleted,
        deferredFloorReason,
      },
    })

    return updated
  },
}
