/**
 * Provider Registry
 *
 * Central registry for all compute providers. Providers register themselves
 * at startup; resolvers and templates look them up by name. Also owns the
 * cross-provider deployment lookups so callers don't repeat the
 * `akash || phala || spheron` chain in every file.
 *
 * Usage:
 *   import {
 *     registerProvider,
 *     getProvider,
 *     getAllProviders,
 *     findActiveDeploymentForService,
 *   } from './registry.js'
 *
 *   registerProvider(createAkashProvider(prisma))
 *   registerProvider(createPhalaProvider(prisma))
 *
 *   const provider = getProvider('akash')
 *   await provider.deploy(serviceId, options)
 *
 *   const found = await findActiveDeploymentForService(prisma, serviceId)
 *   if (found) {
 *     await found.provider.getShell(found.deployment.id, opts)
 *   }
 */

import type { PrismaClient } from '@prisma/client'
import type {
  DeploymentLifecycle,
  DeploymentProvider,
  DeploymentProviderDescriptor,
} from './types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('provider-registry')

const providers = new Map<string, DeploymentProvider>()

export function registerProvider(provider: DeploymentProvider): void {
  if (providers.has(provider.name)) {
    log.warn(`Overwriting existing provider: ${provider.name}`)
  }
  providers.set(provider.name, provider)
  log.info(`Registered provider: ${provider.name} (${provider.displayName})`)
}

export function getProvider(name: string): DeploymentProvider {
  const provider = providers.get(name)
  if (!provider) {
    const available = [...providers.keys()].join(', ') || '(none)'
    throw new Error(`Provider "${name}" not registered. Available: ${available}`)
  }
  return provider
}

export function tryGetProvider(name: string): DeploymentProvider | null {
  return providers.get(name) ?? null
}

export function getAllProviders(): DeploymentProvider[] {
  return [...providers.values()]
}

export function getAvailableProviders(): DeploymentProvider[] {
  return [...providers.values()].filter(p => p.isAvailable())
}

export function hasProvider(name: string): boolean {
  return providers.has(name)
}

// ---------------------------------------------------------------------------
// Cross-provider deployment lookups
//
// Resolvers/services use these helpers instead of hand-rolling
// `prisma.akashDeployment.findFirst(...) || prisma.phalaDeployment.findFirst(...)`
// chains. Adding a new provider only requires implementing
// `DeploymentProvider` with its `descriptor`; these helpers pick it up.
// ---------------------------------------------------------------------------

/**
 * A deployment row joined with the provider that owns it. Returned by
 * the registry lookups so callers can immediately call `provider.close()`,
 * `provider.getShell()`, etc. without a second lookup.
 */
export interface ProviderDeployment {
  provider: DeploymentProvider
  descriptor: DeploymentProviderDescriptor
  deployment: { id: string; status: string } & Record<string, unknown>
}

type DeploymentStatusFilter = 'live' | 'liveOrPending' | 'recent' | readonly string[]

/**
 * Internal: run a findFirst against a provider's Prisma model with the
 * given status filter. The `prismaModel` field on the descriptor maps
 * to the camelCase model name on PrismaClient.
 */
async function findFirstForProvider(
  prisma: PrismaClient,
  provider: DeploymentProvider,
  serviceId: string,
  filter: DeploymentStatusFilter,
): Promise<ProviderDeployment | null> {
  const { descriptor } = provider
  // `prisma[descriptor.prismaModel]` is correct at runtime — TypeScript
  // can't index PrismaClient by a string union, so we cast through
  // `unknown`. Each prismaModel value matches a real Prisma model name.
  const model = (prisma as unknown as Record<string, {
    findFirst: (args: unknown) => Promise<unknown>
  }>)[descriptor.prismaModel]

  let statuses: readonly string[]
  if (filter === 'live') {
    statuses = descriptor.liveStatuses
  } else if (filter === 'liveOrPending') {
    statuses = [...descriptor.liveStatuses, ...descriptor.pendingStatuses]
  } else if (filter === 'recent') {
    // "recent" = anything not in a terminal state. Useful for the
    // delete-service guard: a CREATING deployment that errored out
    // mid-flight isn't terminal yet but blocks deletion.
    statuses = []
  } else {
    statuses = filter
  }

  const where: Record<string, unknown> = { serviceId }
  if (filter === 'recent') {
    where.status = { notIn: descriptor.terminalStatuses }
  } else if (statuses.length > 0) {
    where.status = { in: statuses }
  }

  const row = (await model.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
  })) as ({ id: string; status: string } & Record<string, unknown>) | null

  if (!row) return null
  return { provider, descriptor, deployment: row }
}

/**
 * Find the live deployment for a service, regardless of backing provider.
 * "Live" matches each provider's `descriptor.liveStatuses` (Akash + Phala:
 * ACTIVE only; Spheron: CREATING/STARTING/ACTIVE because hourly billing
 * is already accruing).
 *
 * Returns the first live deployment found, iterating providers in
 * registration order. Returns null if none of the configured providers
 * have a live deployment for this service.
 *
 * This replaces the chains in `shellEndpoint.ts`, `deleteService`,
 * `WorkspaceViewControls`, and similar consumers that previously did
 * `prisma.akashDeployment.findFirst(...) || prisma.phalaDeployment.findFirst(...) || prisma.spheronDeployment.findFirst(...)`.
 */
export async function findActiveDeploymentForService(
  prisma: PrismaClient,
  serviceId: string,
): Promise<ProviderDeployment | null> {
  for (const provider of providers.values()) {
    const hit = await findFirstForProvider(prisma, provider, serviceId, 'live')
    if (hit) return hit
  }
  return null
}

/**
 * Like `findActiveDeploymentForService`, but also includes deployments
 * in any provider's `pendingStatuses`. Used by `deploymentHealth` so
 * the Provider Health card shows up the moment a deploy starts, not
 * only after it reaches ACTIVE. Each provider's descriptor decides
 * what counts as pending — Spheron returns an empty set because
 * CREATING/STARTING already count as "live" in the UX.
 */
export async function findActiveOrPendingDeploymentForService(
  prisma: PrismaClient,
  serviceId: string,
): Promise<ProviderDeployment | null> {
  for (const provider of providers.values()) {
    const hit = await findFirstForProvider(
      prisma,
      provider,
      serviceId,
      'liveOrPending',
    )
    if (hit) return hit
  }
  return null
}

/**
 * Find any deployment that is NOT in a terminal status. Used by the
 * `deleteService` guard, which must refuse deletion if any provider
 * has a mid-flight or active deployment, regardless of whether it has
 * reached ACTIVE yet.
 *
 * Returns an array because multiple providers could theoretically
 * have non-terminal deployments at the same time (shouldn't happen
 * in normal flow, but the delete guard wants to surface all of them).
 */
export async function findAllNonTerminalDeploymentsForService(
  prisma: PrismaClient,
  serviceId: string,
): Promise<ProviderDeployment[]> {
  const hits: ProviderDeployment[] = []
  for (const provider of providers.values()) {
    const hit = await findFirstForProvider(prisma, provider, serviceId, 'recent')
    if (hit) hits.push(hit)
  }
  return hits
}

/**
 * Count active deployments across all providers for a set of project
 * IDs. Used by `workspaceMetrics` to render the "X active deployments"
 * pill on the dashboard.
 */
export async function countActiveDeploymentsForProjects(
  prisma: PrismaClient,
  projectIds: string[],
): Promise<number> {
  if (projectIds.length === 0) return 0
  const counts = await Promise.all(
    [...providers.values()].map(async (provider) => {
      const model = (prisma as unknown as Record<string, {
        count: (args: unknown) => Promise<number>
      }>)[provider.descriptor.prismaModel]
      return model.count({
        where: {
          status: { in: provider.descriptor.liveStatuses },
          service: { projectId: { in: projectIds } },
        },
      })
    }),
  )
  return counts.reduce((acc, n) => acc + n, 0)
}

/**
 * Count total deployments (any status) across all providers for the
 * given project IDs. Surface on `workspaceMetrics.deployments.total`.
 */
export async function countTotalDeploymentsForProjects(
  prisma: PrismaClient,
  projectIds: string[],
): Promise<number> {
  if (projectIds.length === 0) return 0
  const counts = await Promise.all(
    [...providers.values()].map(async (provider) => {
      const model = (prisma as unknown as Record<string, {
        count: (args: unknown) => Promise<number>
      }>)[provider.descriptor.prismaModel]
      return model.count({
        where: { service: { projectId: { in: projectIds } } },
      })
    }),
  )
  return counts.reduce((acc, n) => acc + n, 0)
}

/**
 * Result row from `findRecentDeploymentsForProjects`. Provider-specific
 * fields live on `deployment` and `serviceMeta`; everything else is
 * normalised so consumers can flat-map across providers without
 * inspecting the `provider.name`.
 */
export interface RecentDeploymentRow {
  providerName: string
  unifiedStatus: DeploymentLifecycle
  nativeStatus: string
  deployment: Record<string, unknown>
}

/**
 * Fetch the most recent `take` deployments for the given project IDs,
 * across every provider. Each row is annotated with the provider name
 * and the unified DeploymentLifecycle so the `allDeployments` resolver
 * can render them in a single timeline without per-provider casework.
 *
 * Returns the rows sorted newest-first per provider — callers usually
 * merge + re-sort by createdAt.
 */
export async function findRecentDeploymentsForProjects(
  prisma: PrismaClient,
  projectIds: string[],
  take: number,
): Promise<RecentDeploymentRow[]> {
  if (projectIds.length === 0) return []
  const rows = await Promise.all(
    [...providers.values()].map(async (provider) => {
      const { descriptor } = provider
      const model = (prisma as unknown as Record<string, {
        findMany: (args: unknown) => Promise<Array<{ status: string } & Record<string, unknown>>>
      }>)[descriptor.prismaModel]
      const deployments = await model.findMany({
        where: { service: { projectId: { in: projectIds } } },
        include: {
          service: {
            select: { name: true, slug: true, type: true, projectId: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
      })
      return deployments.map<RecentDeploymentRow>((d) => ({
        providerName: descriptor.name,
        unifiedStatus: descriptor.unifiedStatusMap[d.status] ?? 'FAILED',
        nativeStatus: d.status,
        deployment: d,
      }))
    }),
  )
  return rows.flat()
}

/**
 * Find the provider that owns a given native status string. Useful
 * when a tool gets a deployment row from a flat query and needs to
 * resolve it back to its provider class without an `if/else`.
 *
 * Returns null when the status isn't recognised by any provider.
 */
export function findProviderForNativeStatus(
  prismaModel: DeploymentProviderDescriptor['prismaModel'],
): DeploymentProvider | null {
  for (const p of providers.values()) {
    if (p.descriptor.prismaModel === prismaModel) return p
  }
  return null
}
