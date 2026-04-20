/**
 * GraphQL resolvers for the GitHub-source deploy flow.
 *
 * Two service-creation paths exist; both end up at the same `startBuild`
 * helper which spawns the K8s builder Job:
 *
 *   1. `createGithubService(input)` — all-in-one: creates the Service row
 *      and connects it to the repo in one mutation. Used by API/CLI users
 *      who already know everything they need.
 *
 *   2. `connectGithubRepo(input)` — connects an existing (empty,
 *      github-flavor) Service created by the catalog flow. This is the
 *      panel UX: user picks "GitHub" from the catalog, lands in the
 *      Source tab, picks installation/repo/branch.
 *
 * The compute provider that runs the built image is NOT chosen here —
 * the build callback auto-deploys via the existing per-deploy provider
 * mechanism (active deployment's provider on rebuilds, ComputeMode
 * default on first deploy). Same pattern as docker/server flavors.
 */

import { GraphQLError } from 'graphql'
import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { generateSlug } from '../utils/slug.js'
import { generateInternalHostname } from '../utils/internalHostname.js'
import { createLogger } from '../lib/logger.js'
import { getGithubAppConfig, isGithubAppConfigured } from '../services/github/config.js'
import {
  getInstallation,
  listInstallationRepos,
  listRepoBranches,
  getRepo,
  getCommit,
} from '../services/github/client.js'
import { spawnBuildJob } from '../services/github/buildSpawner.js'

const log = createLogger('resolvers.github')

function assertGithubConfigured() {
  if (!isGithubAppConfigured()) {
    throw new GraphQLError('GitHub deploy is not enabled on this server', {
      extensions: { code: 'NOT_CONFIGURED' },
    })
  }
}

function imageTagFor(userId: string, owner: string, repo: string, sha: string): string {
  const cfg = getGithubAppConfig()
  // ghcr is case-insensitive and lowercases on the server; pre-lowercase
  // here so logs / DB rows match what any provider will eventually pull.
  const safeOwner = owner.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const safeRepo = repo.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `ghcr.io/${cfg.ghcrNamespace}/${userId}--${safeOwner}-${safeRepo}:${sha.slice(0, 12)}`
}

// =====================================================================
// Queries
// =====================================================================

export const githubQueries = {
  githubAppEnabled: () => isGithubAppConfigured(),

  /** Slug used in install URLs: https://github.com/apps/<slug>/installations/new */
  githubAppSlug: () => {
    if (!isGithubAppConfigured()) return null
    return getGithubAppConfig().appSlug
  },

  githubInstallations: async (
    _: unknown,
    args: { orgId?: string },
    context: Context,
  ) => {
    requireAuth(context)
    assertGithubConfigured()
    const orgId = args.orgId || context.organizationId
    if (!orgId) throw new GraphQLError('orgId required')
    return context.prisma.githubInstallation.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    })
  },

  githubInstallationRepos: async (
    _: unknown,
    args: { installationId: string },
    context: Context,
  ) => {
    requireAuth(context)
    assertGithubConfigured()
    const install = await context.prisma.githubInstallation.findUnique({
      where: { id: args.installationId },
    })
    if (!install) throw new GraphQLError('installation not found')
    if (context.organizationId && install.organizationId !== context.organizationId) {
      throw new GraphQLError('not authorized', { extensions: { code: 'FORBIDDEN' } })
    }
    const repos = await listInstallationRepos(install.installationId)
    return repos.map((r) => ({
      id: String(r.id),
      name: r.name,
      fullName: r.full_name,
      owner: r.owner.login,
      private: r.private,
      defaultBranch: r.default_branch,
      description: r.description,
      pushedAt: r.pushed_at,
      language: r.language,
      htmlUrl: r.html_url,
    }))
  },

  githubRepoBranches: async (
    _: unknown,
    args: { installationId: string; owner: string; repo: string },
    context: Context,
  ) => {
    requireAuth(context)
    assertGithubConfigured()
    const install = await context.prisma.githubInstallation.findUnique({
      where: { id: args.installationId },
    })
    if (!install) throw new GraphQLError('installation not found')
    if (context.organizationId && install.organizationId !== context.organizationId) {
      throw new GraphQLError('not authorized', { extensions: { code: 'FORBIDDEN' } })
    }
    const branches = await listRepoBranches(install.installationId, args.owner, args.repo)
    return branches.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }))
  },
}

// =====================================================================
// Shared: spawn a BuildJob + builder Job for a service that's already
// been connected to a git repo. Used by createGithubService,
// connectGithubRepo, and redeployGithubService.
// =====================================================================

async function startBuild(
  context: Context,
  args: {
    serviceId: string
    userId: string
    installationIdNum: bigint
    owner: string
    repo: string
    branch: string
    rootDirectory: string | null
    buildCommand: string | null
    startCommand: string | null
    triggeredBy: string
  },
) {
  const commit = await getCommit(args.installationIdNum, args.owner, args.repo, args.branch)

  const buildJob = await context.prisma.buildJob.create({
    data: {
      serviceId: args.serviceId,
      commitSha: commit.sha,
      commitMessage: commit.commit.message.slice(0, 1000),
      branch: args.branch,
      triggeredBy: args.triggeredBy,
    },
  })

  const imageTag = imageTagFor(args.userId, args.owner, args.repo, commit.sha)
  try {
    const spawned = await spawnBuildJob({
      buildJobId: buildJob.id,
      installationId: args.installationIdNum,
      repoOwner: args.owner,
      repoName: args.repo,
      commitSha: commit.sha,
      imageTag,
      rootDirectory: args.rootDirectory ?? undefined,
      buildCommand: args.buildCommand ?? undefined,
      startCommand: args.startCommand ?? undefined,
    })
    await context.prisma.buildJob.update({
      where: { id: buildJob.id },
      data: { k8sJobName: spawned.k8sJobName, status: 'RUNNING' },
    })
  } catch (err) {
    log.error({ err, buildJobId: buildJob.id }, 'failed to spawn builder Job')
    await context.prisma.buildJob.update({
      where: { id: buildJob.id },
      data: {
        status: 'FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    })
    throw new GraphQLError('failed to start build', {
      extensions: { code: 'BUILDER_SPAWN_FAILED' },
    })
  }

  return buildJob
}

// =====================================================================
// Mutations
// =====================================================================

export const githubMutations = {
  /**
   * After the user clicks "Install" on github.com, GitHub redirects them to
   * our setup_url with `?installation_id=...&setup_action=install`. The
   * frontend calls this mutation to confirm and persist the install.
   *
   * The webhook (`installation` event) covers the same ground asynchronously,
   * but calling this mutation makes the UI feel synchronous.
   */
  syncGithubInstallation: async (
    _: unknown,
    args: { installationId: string; orgId?: string },
    context: Context,
  ) => {
    const userId = requireAuth(context)
    assertGithubConfigured()
    const orgId = args.orgId || context.organizationId
    if (!orgId) throw new GraphQLError('orgId required')

    // Verify ownership of the org
    const member = await context.prisma.organizationMember.findFirst({
      where: { organizationId: orgId, userId },
    })
    if (!member) throw new GraphQLError('not a member of this org', { extensions: { code: 'FORBIDDEN' } })

    const installIdNum = BigInt(args.installationId)
    const meta = await getInstallation(installIdNum)

    return context.prisma.githubInstallation.upsert({
      where: { installationId: installIdNum },
      create: {
        organizationId: orgId,
        installationId: installIdNum,
        accountLogin: meta.account.login,
        accountId: BigInt(meta.account.id),
        accountType: meta.account.type,
        targetType: meta.repository_selection,
        installedByUserId: userId,
        suspendedAt: meta.suspended_at ? new Date(meta.suspended_at) : null,
      },
      update: {
        accountLogin: meta.account.login,
        accountId: BigInt(meta.account.id),
        accountType: meta.account.type,
        targetType: meta.repository_selection,
        suspendedAt: meta.suspended_at ? new Date(meta.suspended_at) : null,
      },
    })
  },

  /**
   * All-in-one: create the Service row and connect it to a repo, then
   * spawn the first build. Used by API/CLI consumers who don't go
   * through the catalog → panel UX.
   */
  createGithubService: async (
    _: unknown,
    args: {
      input: {
        projectId: string
        installationId: string
        owner: string
        repo: string
        branch?: string
        rootDirectory?: string
        buildCommand?: string
        startCommand?: string
        name?: string
        envVars?: Array<{ key: string; value: string; secret?: boolean }>
      }
    },
    context: Context,
  ) => {
    const userId = requireAuth(context)
    assertGithubConfigured()
    const { input } = args

    const project = await context.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, slug: true, userId: true, organizationId: true },
    })
    if (!project) throw new GraphQLError('project not found')
    assertProjectAccess(context, project)

    const install = await context.prisma.githubInstallation.findUnique({
      where: { id: input.installationId },
    })
    if (!install) throw new GraphQLError('installation not found')
    if (install.suspendedAt) throw new GraphQLError('installation is suspended on GitHub')

    // Confirm the repo + branch are real (live API call)
    const repo = await getRepo(install.installationId, input.owner, input.repo)
    const branchName = input.branch || repo.default_branch

    // Slugs must be unique within a project; suffix on collision.
    const baseSlug = generateSlug(input.name || repo.name)
    let slug = baseSlug
    for (let i = 1; i < 50; i++) {
      const exists = await context.prisma.service.findFirst({
        where: { projectId: project.id, slug },
        select: { id: true },
      })
      if (!exists) break
      slug = `${baseSlug}-${i}`
    }

    const service = await context.prisma.service.create({
      data: {
        type: 'VM',
        name: input.name || repo.name,
        slug,
        projectId: project.id,
        flavor: 'github',
        createdByUserId: userId,
        gitProvider: 'github',
        gitOwner: input.owner,
        gitRepo: input.repo,
        gitBranch: branchName,
        gitInstallationId: install.id,
        rootDirectory: input.rootDirectory ?? null,
        buildCommand: input.buildCommand ?? null,
        startCommand: input.startCommand ?? null,
        internalHostname: generateInternalHostname(slug, project.slug),
      },
    })

    if (input.envVars && input.envVars.length > 0) {
      await context.prisma.serviceEnvVar.createMany({
        data: input.envVars.map((e) => ({
          serviceId: service.id,
          key: e.key,
          value: e.value,
          secret: e.secret ?? true,
        })),
      })
    }

    await startBuild(context, {
      serviceId: service.id,
      userId,
      installationIdNum: install.installationId,
      owner: input.owner,
      repo: input.repo,
      branch: branchName,
      rootDirectory: input.rootDirectory ?? null,
      buildCommand: input.buildCommand ?? null,
      startCommand: input.startCommand ?? null,
      triggeredBy: 'first-deploy',
    })

    return service
  },

  /**
   * Panel-flow connect: an empty, github-flavor Service already exists
   * (created by the catalog → createService path); attach a repo to it
   * and spawn the first build. Idempotent for the "user changed mind"
   * case — re-calling overwrites the connection only if no successful
   * build has happened yet.
   */
  connectGithubRepo: async (
    _: unknown,
    args: {
      input: {
        serviceId: string
        installationId: string
        owner: string
        repo: string
        branch?: string
        rootDirectory?: string
        buildCommand?: string
        startCommand?: string
      }
    },
    context: Context,
  ) => {
    const userId = requireAuth(context)
    assertGithubConfigured()
    const { input } = args

    const service = await context.prisma.service.findUnique({
      where: { id: input.serviceId },
      include: { project: true },
    })
    if (!service) throw new GraphQLError('service not found')
    assertProjectAccess(context, service.project)
    if (service.flavor !== 'github') {
      throw new GraphQLError(
        `Service ${service.id} has flavor "${service.flavor ?? 'null'}" — connectGithubRepo only works on github-flavor services`,
        { extensions: { code: 'WRONG_FLAVOR' } },
      )
    }
    if (service.lastBuildStatus === 'SUCCEEDED') {
      throw new GraphQLError(
        'Service is already connected and has a successful build. Use redeployGithubService to rebuild.',
        { extensions: { code: 'ALREADY_CONNECTED' } },
      )
    }

    const install = await context.prisma.githubInstallation.findUnique({
      where: { id: input.installationId },
    })
    if (!install) throw new GraphQLError('installation not found')
    if (install.suspendedAt) throw new GraphQLError('installation is suspended on GitHub')

    const repo = await getRepo(install.installationId, input.owner, input.repo)
    const branchName = input.branch || repo.default_branch

    const updated = await context.prisma.service.update({
      where: { id: service.id },
      data: {
        gitProvider: 'github',
        gitOwner: input.owner,
        gitRepo: input.repo,
        gitBranch: branchName,
        gitInstallationId: install.id,
        rootDirectory: input.rootDirectory ?? null,
        buildCommand: input.buildCommand ?? null,
        startCommand: input.startCommand ?? null,
      },
    })

    await startBuild(context, {
      serviceId: updated.id,
      userId,
      installationIdNum: install.installationId,
      owner: input.owner,
      repo: input.repo,
      branch: branchName,
      rootDirectory: input.rootDirectory ?? null,
      buildCommand: input.buildCommand ?? null,
      startCommand: input.startCommand ?? null,
      triggeredBy: 'first-deploy',
    })

    return updated
  },

  redeployGithubService: async (
    _: unknown,
    args: { serviceId: string },
    context: Context,
  ) => {
    const userId = requireAuth(context)
    assertGithubConfigured()

    const service = await context.prisma.service.findUnique({
      where: { id: args.serviceId },
      include: { project: true, gitInstallation: true },
    })
    if (!service) throw new GraphQLError('service not found')
    assertProjectAccess(context, service.project)
    if (!service.gitInstallation || !service.gitOwner || !service.gitRepo || !service.gitBranch) {
      throw new GraphQLError('service is not connected to a git repo')
    }

    return startBuild(context, {
      serviceId: service.id,
      userId,
      installationIdNum: service.gitInstallation.installationId,
      owner: service.gitOwner,
      repo: service.gitRepo,
      branch: service.gitBranch,
      rootDirectory: service.rootDirectory,
      buildCommand: service.buildCommand,
      startCommand: service.startCommand,
      triggeredBy: `manual:${userId}`,
    })
  },
}

// =====================================================================
// Field resolvers
// =====================================================================

export const githubFieldResolvers = {
  GithubInstallation: {
    installationId: (parent: { installationId: bigint | number | string }) =>
      String(parent.installationId),
    accountId: (parent: { accountId: bigint | number | string }) => String(parent.accountId),
  },
  Service: {
    latestBuild: async (parent: { id: string }, _: unknown, context: Context) => {
      return context.prisma.buildJob.findFirst({
        where: { serviceId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
    buildJobs: async (parent: { id: string }, args: { limit?: number }, context: Context) => {
      return context.prisma.buildJob.findMany({
        where: { serviceId: parent.id },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(args.limit ?? 20, 1), 100),
      })
    },
  },
}
