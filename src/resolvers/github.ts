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

/**
 * Validate user-supplied `rootDirectory` before it lands on the Service row
 * (and from there into `cd "$ROOT_DIRECTORY"` inside the builder script).
 *
 * Allowed: relative paths made of [a-zA-Z0-9._-/] segments, no `..` segments,
 * no leading `/`, no leading `~`, max 256 chars. `null`/empty pass through
 * (means "repo root", handled downstream by `input.rootDirectory || '.'`).
 *
 * We deliberately reject `..` even mid-path — there's no legitimate use case
 * for a builder workdir to escape the clone, and silently allowing it is
 * how shell-injection foot-guns get found by reviewers (rightly so).
 */
function normalizeRootDirectory(input: string | null | undefined): string | null {
  if (input == null) return null
  const trimmed = input.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === './') return null
  if (trimmed.length > 256) {
    throw new GraphQLError('rootDirectory too long (max 256 chars)', {
      extensions: { code: 'INVALID_ROOT_DIRECTORY' },
    })
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    throw new GraphQLError('rootDirectory must be a relative path inside the repo', {
      extensions: { code: 'INVALID_ROOT_DIRECTORY' },
    })
  }
  // Disallow any segment that's exactly `..` — safer than a regex `..` ban
  // which would also reject a legitimate `my..weird..folder` (uncommon but
  // legal on GitHub).
  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (seg === '..') {
      throw new GraphQLError('rootDirectory cannot traverse above the repo root', {
        extensions: { code: 'INVALID_ROOT_DIRECTORY' },
      })
    }
  }
  if (!/^[A-Za-z0-9._\-/]+$/.test(trimmed)) {
    throw new GraphQLError(
      'rootDirectory may only contain letters, numbers, dot, dash, underscore, and slash',
      { extensions: { code: 'INVALID_ROOT_DIRECTORY' } },
    )
  }
  return trimmed
}

/**
 * Validate user-supplied build/start commands.
 *
 * Intentionally permissive on shell syntax — these strings are run verbatim
 * by the af-builder Job (`bash -lc "$BUILD_COMMAND"` after b64 round-trip),
 * which is the feature: users type "pnpm run build:prod && rm -rf dist/foo"
 * and it has to work. Banning shell metacharacters would break the product.
 *
 * What we DO guard against:
 *   - Length: 4 KiB cap so a runaway frontend (or attacker) can't pin a
 *     row with a multi-MiB blob and balloon DB / log payloads.
 *   - Null bytes: Postgres TEXT chokes on \0 in some drivers and they
 *     have no legitimate place in a shell command.
 *
 * Returns the trimmed string (or null for empty) so callers don't have to
 * remember whether they validated; if it returned, it's safe to persist.
 */
function normalizeShellCommand(
  input: string | null | undefined,
  fieldName: 'buildCommand' | 'startCommand',
): string | null {
  if (input == null) return null
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (trimmed.length > 4096) {
    throw new GraphQLError(`${fieldName} too long (max 4096 chars)`, {
      extensions: { code: 'INVALID_COMMAND' },
    })
  }
  if (trimmed.includes('\0')) {
    throw new GraphQLError(`${fieldName} cannot contain null bytes`, {
      extensions: { code: 'INVALID_COMMAND' },
    })
  }
  return trimmed
}

/**
 * Throws unless the caller is a member of an AF org that has access to the
 * given GitHub installation.
 *
 * Use this on every read/mutation that derives data from (or attaches
 * downstream resources to) a `GithubInstallation` row. The access table is
 * the primary tenant boundary; `organizationId` is the legacy original owner —
 * `context.organizationId` (header-derived) cannot be trusted for
 * GitHub-related authz because:
 *
 *   1. Many legitimate code paths don't set `X-Organization-Id`
 *      (web-app's `services/github/actions.ts`, CLI, PAT users).
 *      Falsy `context.organizationId` previously short-circuited the
 *      check `if (context.organizationId && install.organizationId !== context.organizationId)`,
 *      letting any authenticated user fetch any install's repos.
 *   2. `githubInstallations(orgId: X)` historically returned the
 *      install's local cuid id without verifying the caller's org
 *      membership, giving an attacker the cuid needed to call
 *      `githubInstallationRepos`.
 *
 * Combining (1) and (2) gave a fully-closed exploit chain. This helper keeps
 * that closed while allowing normal GitHub team behavior: one GitHub org
 * installation can be granted to multiple AF orgs after GitHub redirects back
 * with the real installation_id.
 */
async function assertInstallationAccess(
  context: Context,
  install: { id: string; organizationId: string },
): Promise<void> {
  const userId = requireAuth(context)
  const member = await context.prisma.organizationMember.findFirst({
    where: {
      userId,
      OR: [
        { organizationId: install.organizationId },
        {
          organization: {
            githubInstallationAccesses: {
              some: { installationId: install.id },
            },
          },
        },
      ],
    },
    select: { id: true },
  })
  if (!member) {
    throw new GraphQLError('not authorized for this GitHub installation', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

async function grantInstallationAccess(
  context: Context,
  install: { id: string },
  orgId: string,
  userId: string,
  source = 'setup_url',
): Promise<void> {
  await context.prisma.githubInstallationAccess.upsert({
    where: {
      installationId_organizationId: {
        installationId: install.id,
        organizationId: orgId,
      },
    },
    create: {
      installationId: install.id,
      organizationId: orgId,
      grantedByUserId: userId,
      source,
    },
    update: {
      grantedByUserId: userId,
      source,
    },
  })
}

async function assertInstallationAccessToOrg(
  context: Context,
  install: { id: string; organizationId: string },
  orgId: string | null,
): Promise<void> {
  if (!orgId) {
    throw new GraphQLError('GitHub services must belong to an organization-scoped project', {
      extensions: { code: 'INSTALL_ORG_MISMATCH' },
    })
  }
  await assertOrgMembership(context, orgId)
  if (install.organizationId === orgId) return
  const access = await context.prisma.githubInstallationAccess.findUnique({
    where: {
      installationId_organizationId: {
        installationId: install.id,
        organizationId: orgId,
      },
    },
    select: { id: true },
  })
  if (!access) {
    throw new GraphQLError(
      'GitHub installation is not connected to this AlternateFutures organization',
      { extensions: { code: 'INSTALL_ORG_MISMATCH' } },
    )
  }
}

/**
 * Throws unless the caller is a member of the given AF organization.
 * Lighter-weight cousin of `assertInstallationAccess` for queries that
 * take an `orgId` arg directly (e.g. `githubInstallations`).
 */
async function assertOrgMembership(context: Context, orgId: string): Promise<void> {
  const userId = requireAuth(context)
  const member = await context.prisma.organizationMember.findFirst({
    where: { organizationId: orgId, userId },
    select: { id: true },
  })
  if (!member) {
    throw new GraphQLError('not a member of this organization', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

function imageTagFor(userId: string, owner: string, repo: string, sha: string): string {
  const cfg = getGithubAppConfig()
  // Docker registry refs MUST be all lowercase. Prisma cuid userIds like
  // `gbufejdLUQOs2lh3MLjDS` mix case and break `docker build -t …`. Lowercase
  // every component so the tag is valid before nixpacks/buildx ever sees it.
  const safeUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const safeOwner = owner.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const safeRepo = repo.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `ghcr.io/${cfg.ghcrNamespace}/${safeUserId}--${safeOwner}-${safeRepo}:${sha.slice(0, 12)}`
}

// =====================================================================
// Queries
// =====================================================================

export const githubQueries = {
  githubAppEnabled: () => isGithubAppConfigured(),

  /**
   * Lazy-load a single BuildJob by id, including the heavy `logs` blob.
   *
   * The Source-tab build-history list intentionally omits `logs` from its
   * polling query (logs can be 60KB per row, polled every 3s while a build
   * is in flight — that's a lot of bytes for collapsed rows nobody is
   * looking at). When the user expands a row, we hit this query for that
   * one job. Auth-checked: caller must own the parent service's project.
   */
  buildJob: async (_: unknown, args: { id: string }, context: Context) => {
    requireAuth(context)
    const job = await context.prisma.buildJob.findUnique({
      where: { id: args.id },
      include: { service: { include: { project: true } } },
    })
    if (!job) return null
    assertProjectAccess(context, job.service.project)
    return job
  },

  /**
   * List recent BuildJobs for a service. Mirrors the `Service.buildJobs(limit)`
   * field resolver but is reachable without first fetching the parent Service
   * — the Source-tab build-history list only knows the serviceId and doesn't
   * want to round-trip the entire Service payload on every 3s poll.
   *
   * Logs blob is intentionally available on each row (the schema can't gate
   * fields per-query), but the frontend polling query OMITS `logs` from its
   * selection set; logs are fetched via `buildJob(id)` only on row expand.
   */
  serviceBuildJobs: async (
    _: unknown,
    args: { serviceId: string; limit?: number },
    context: Context,
  ) => {
    requireAuth(context)
    const service = await context.prisma.service.findUnique({
      where: { id: args.serviceId },
      include: { project: true },
    })
    if (!service) throw new GraphQLError('service not found')
    assertProjectAccess(context, service.project)
    return context.prisma.buildJob.findMany({
      where: { serviceId: args.serviceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(args.limit ?? 20, 1), 100),
    })
  },

  /** Slug used in install URLs: https://github.com/apps/<slug>/installations/new */
  githubAppSlug: () => {
    if (!isGithubAppConfigured()) return null
    return getGithubAppConfig().appSlug
  },

  /**
   * Return the current HEAD SHA of the service's tracked git branch.
   *
   * Used by the source-differs banner: the frontend compares this against
   * `lastBuildSha` to decide whether to show "Source has changed since last
   * deploy — Redeploy?" on the service Overview panel.
   *
   * Returns null for:
   *   - Non-git services (gitProvider != 'github' or missing install/owner/repo/branch)
   *   - GitHub App not configured on this server
   *   - Any GitHub API error (network timeout, 404 if repo/branch deleted, etc.)
   *
   * Failing open (null) is intentional: the banner must not block access to the
   * panel when the API is unreachable. Callers treat null as "unknown".
   */
  serviceGitHead: async (
    _: unknown,
    args: { serviceId: string },
    context: Context,
  ): Promise<string | null> => {
    requireAuth(context)
    const service = await context.prisma.service.findUnique({
      where: { id: args.serviceId },
      include: { project: true },
    })
    if (!service) throw new GraphQLError('service not found')
    assertProjectAccess(context, service.project)
    if (
      service.gitProvider !== 'github' ||
      !service.gitInstallationId ||
      !service.gitOwner ||
      !service.gitRepo ||
      !service.gitBranch
    ) {
      return null
    }
    if (!isGithubAppConfigured()) return null
    const install = await context.prisma.githubInstallation.findUnique({
      where: { id: service.gitInstallationId },
      select: { installationId: true },
    })
    if (!install) return null
    try {
      const commit = await getCommit(
        install.installationId,
        service.gitOwner,
        service.gitRepo,
        service.gitBranch,
      )
      return commit.sha
    } catch {
      // GitHub API unreachable, repo deleted, branch deleted, etc.
      return null
    }
  },

  /**
   * Pure DB read — fast (<10ms). The picker mounts on every panel open
   * and we used to live-sync to GitHub here, which on a cold module
   * load (tsx-watch + jsonwebtoken + GitHub TLS + sequential upserts)
   * blew past 12s and wedged the UI. Live-sync is now an explicit
   * mutation (`refreshGithubInstallations`) the UI calls only when it
   * actually needs fresh data: empty cache, Refresh button, or after
   * the user installs the App in a popup. Webhook-driven upserts will
   * keep the cache fresh in prod once we wire `installation` events.
   */
  githubInstallations: async (
    _: unknown,
    args: { orgId?: string },
    context: Context,
  ) => {
    requireAuth(context)
    assertGithubConfigured()
    const orgId = args.orgId || context.organizationId
    if (!orgId) throw new GraphQLError('orgId required')
    // Without this membership check, any authenticated user could pass
    // an arbitrary `orgId` and enumerate every GithubInstallation row
    // (including the local cuid used as input to githubInstallationRepos).
    await assertOrgMembership(context, orgId)
    return context.prisma.githubInstallation.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { accesses: { some: { organizationId: orgId } } },
        ],
      },
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
    // Authoritative tenant boundary is the install row itself, not
    // the caller's request header — see assertInstallationAccess docs.
    await assertInstallationAccess(context, install)
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
    await assertInstallationAccess(context, install)
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
    /** Branch name persisted on the BuildJob — what shows up in the UI as "main", "develop", etc. */
    branch: string
    /**
     * Optional override of the GitHub ref used to RESOLVE the commit (passes
     * through to GET /repos/:owner/:repo/commits/:ref, which accepts a branch
     * name OR a SHA). Used by per-commit rebuilds from the build-history UI:
     * we still tag the BuildJob with the original branch label, but resolve
     * the commit at the user-specified SHA. Defaults to `branch`.
     */
    ref?: string
    rootDirectory: string | null
    buildCommand: string | null
    startCommand: string | null
    triggeredBy: string
  },
) {
  const commit = await getCommit(args.installationIdNum, args.owner, args.repo, args.ref ?? args.branch)

  const buildJob = await context.prisma.buildJob.create({
    data: {
      serviceId: args.serviceId,
      commitSha: commit.sha,
      commitMessage: commit.commit.message.slice(0, 1000),
      branch: args.branch,
      triggeredBy: args.triggeredBy,
    },
  })

  // Mirror the new build's metadata onto the Service so the UI's Source-tab
  // build card reflects progress without waiting for a builder callback. The
  // build callback later overwrites lastBuildStatus with SUCCEEDED / FAILED;
  // in BUILDER_DRY_RUN mode the callback never fires, so this is also what
  // makes local dev show PENDING instead of "No builds yet".
  await context.prisma.service.update({
    where: { id: args.serviceId },
    data: {
      lastBuildSha: commit.sha,
      lastBuildStatus: 'PENDING',
      lastBuildAt: new Date(),
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
      data: {
        k8sJobName: spawned.k8sJobName,
        status: 'RUNNING',
        logs: spawned.initialLog,
      },
    })
    await context.prisma.service.update({
      where: { id: args.serviceId },
      data: { lastBuildStatus: 'RUNNING' },
    })

    // BUILDER_DRY_RUN=1 short-circuit: no K8s Job was actually created, so the
    // build callback will never fire. Synthesize an immediate SUCCEEDED state
    // (with a fake imageTag) so local dev mirrors prod end-to-end and the UI
    // doesn't sit on "Building…" forever. We deliberately skip the
    // autoDeployAfterBuild step here — local dev usually doesn't want to spend
    // tAKT every time you connect a repo. The user clicks "Deploy" manually.
    if (spawned.dryRun) {
      const now = new Date()
      await context.prisma.buildJob.update({
        where: { id: buildJob.id },
        data: {
          status: 'SUCCEEDED',
          imageTag,
          startedAt: now,
          finishedAt: now,
          logs: 'BUILDER_DRY_RUN=1 — synthetic SUCCEEDED (no K8s Job spawned).',
        },
      })
      await context.prisma.service.update({
        where: { id: args.serviceId },
        data: {
          lastBuildStatus: 'SUCCEEDED',
          lastBuildAt: now,
          dockerImage: imageTag,
        },
      })
    }
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
    await context.prisma.service.update({
      where: { id: args.serviceId },
      data: { lastBuildStatus: 'FAILED' },
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

    const member = await context.prisma.organizationMember.findFirst({
      where: { organizationId: orgId, userId },
    })
    if (!member) throw new GraphQLError('not a member of this org', { extensions: { code: 'FORBIDDEN' } })

    const installIdNum = BigInt(args.installationId)

    // GitHub owns installations at the account/org level. If a second AF org
    // reaches this endpoint, GitHub has redirected them with the real
    // installation_id after an install/configure action, so grant this AF org
    // access to the canonical install instead of treating the first AF org as
    // the exclusive owner.
    const existing = await context.prisma.githubInstallation.findUnique({
      where: { installationId: installIdNum },
      select: { id: true, organizationId: true },
    })
    const meta = await getInstallation(installIdNum)

    const install = existing
      ? await context.prisma.githubInstallation.update({
          where: { id: existing.id },
          data: {
            accountLogin: meta.account.login,
            accountId: BigInt(meta.account.id),
            accountType: meta.account.type,
            targetType: meta.repository_selection,
            suspendedAt: meta.suspended_at ? new Date(meta.suspended_at) : null,
          },
        })
      : await context.prisma.githubInstallation.create({
          data: {
            organizationId: orgId,
            installationId: installIdNum,
            accountLogin: meta.account.login,
            accountId: BigInt(meta.account.id),
            accountType: meta.account.type,
            targetType: meta.repository_selection,
            installedByUserId: userId,
            suspendedAt: meta.suspended_at ? new Date(meta.suspended_at) : null,
          },
        })

    await grantInstallationAccess(context, install, orgId, userId)
    return install
  },

  /**
   * Re-sync **the caller's own** installations' metadata from GitHub.
   *
   * History: this mutation used to call `listAllInstallations()` (which
   * returns every install of the App across ALL of GitHub, via the App
   * JWT) and then upsert every row with `organizationId = caller's org`.
   * That made the **first AF tenant to hit Refresh** silently claim
   * every installation in the world into their tenant — a critical
   * multi-tenant data leak the moment the App went public on
   * 2026-04-22.
   *
   * Fixed shape:
   *  1. Read the caller org's accessible installations from the DB.
   *  2. For each, hit `GET /app/installations/{id}` to refresh metadata
   *     (suspended_at, repository_selection, account rename, etc.).
   *  3. Never create a new row here. New installs are claimed exactly
   *     once, by `syncGithubInstallation`, which is called from the
   *     post-install setup_url hook with the exact install_id GitHub
   *     redirected with. That path verifies org membership and uses
   *     `installationId` as the unique key. A GitHub org install can then be
   *     shared to additional AF orgs when GitHub redirects those users back.
   *
   * If you need to re-discover installs that are known to GitHub but
   * missing locally (e.g. webhook delivery failed), the intended UX is
   * to have the user click "Install" again — GitHub routes them to the
   * configure page, which triggers a fresh setup_url redirect and
   * therefore a fresh `syncGithubInstallation` call.
   */
  refreshGithubInstallations: async (
    _: unknown,
    args: { orgId?: string },
    context: Context,
  ) => {
    requireAuth(context)
    assertGithubConfigured()
    const orgId = args.orgId || context.organizationId
    if (!orgId) throw new GraphQLError('orgId required')

    await assertOrgMembership(context, orgId)

    const owned = await context.prisma.githubInstallation.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { accesses: { some: { organizationId: orgId } } },
        ],
      },
      select: { id: true, installationId: true },
    })

    await Promise.all(
      owned.map(async (row) => {
        try {
          const meta = await getInstallation(row.installationId)
          await context.prisma.githubInstallation.update({
            where: { id: row.id },
            data: {
              accountLogin: meta.account.login,
              accountId: BigInt(meta.account.id),
              accountType: meta.account.type,
              targetType: meta.repository_selection,
              suspendedAt: meta.suspended_at ? new Date(meta.suspended_at) : null,
            },
          })
        } catch (err) {
          // Per-row failure is expected (install deleted out-of-band,
          // transient GitHub 5xx, etc.). Log + move on; caller still
          // gets the DB view below.
          log.warn(
            {
              installationId: String(row.installationId),
              err: err instanceof Error ? err.message : String(err),
            },
            'per-installation refresh failed',
          )
        }
      }),
    )

    return context.prisma.githubInstallation.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { accesses: { some: { organizationId: orgId } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
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
    const safeRootDirectory = normalizeRootDirectory(input.rootDirectory)
    const safeBuildCommand = normalizeShellCommand(input.buildCommand, 'buildCommand')
    const safeStartCommand = normalizeShellCommand(input.startCommand, 'startCommand')

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
    // Even though `assertProjectAccess` proved the caller owns the
    // project, that says nothing about whether they're allowed to
    // attach THIS installation to it. Without this check a caller
    // could enumerate any install's local cuid (until the
    // githubInstallations membership check landed in the same diff)
    // and bridge a victim's GitHub repo into their own project,
    // triggering a build that pulls private source from GitHub via
    // the install token. Require the install's org match the
    // project's org (and the caller be a member of that org).
    await assertInstallationAccess(context, install)
    await assertInstallationAccessToOrg(context, install, project.organizationId)
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
        rootDirectory: safeRootDirectory,
        buildCommand: safeBuildCommand,
        startCommand: safeStartCommand,
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
      rootDirectory: safeRootDirectory,
      buildCommand: safeBuildCommand,
      startCommand: safeStartCommand,
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
    const safeRootDirectory = normalizeRootDirectory(input.rootDirectory)
    const safeBuildCommand = normalizeShellCommand(input.buildCommand, 'buildCommand')
    const safeStartCommand = normalizeShellCommand(input.startCommand, 'startCommand')

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
    // Same reasoning as createGithubService — the project ownership
    // check doesn't authorize the install. Require both: caller is a
    // member of install's org AND that org owns the project.
    await assertInstallationAccess(context, install)
    await assertInstallationAccessToOrg(context, install, service.project.organizationId)
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
        rootDirectory: safeRootDirectory,
        buildCommand: safeBuildCommand,
        startCommand: safeStartCommand,
      },
    })

    await startBuild(context, {
      serviceId: updated.id,
      userId,
      installationIdNum: install.installationId,
      owner: input.owner,
      repo: input.repo,
      branch: branchName,
      rootDirectory: safeRootDirectory,
      buildCommand: safeBuildCommand,
      startCommand: safeStartCommand,
      triggeredBy: 'first-deploy',
    })

    return updated
  },

  redeployGithubService: async (
    _: unknown,
    args: { serviceId: string; sha?: string | null },
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

    // Optional `sha` override: per-commit rebuild from the build-history UI.
    // Validate strictly to a hex SHA before flowing it into the GitHub commit
    // URL path — `getCommit` accepts any ref (branch, SHA, tag), and we don't
    // want unvalidated user input riding along to GitHub or, after resolution,
    // becoming part of a docker image tag.
    let ref: string | undefined
    let triggeredBy = `manual:${userId}`
    if (args.sha != null && args.sha !== '') {
      const sha = args.sha.trim().toLowerCase()
      if (!/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new GraphQLError('sha must be a 7-40 character hex commit SHA', {
          extensions: { code: 'INVALID_SHA' },
        })
      }
      ref = sha
      triggeredBy = `manual-sha:${userId}`
    }

    return startBuild(context, {
      serviceId: service.id,
      userId,
      installationIdNum: service.gitInstallation.installationId,
      owner: service.gitOwner,
      repo: service.gitRepo,
      branch: service.gitBranch,
      ref,
      rootDirectory: service.rootDirectory,
      buildCommand: service.buildCommand,
      startCommand: service.startCommand,
      triggeredBy,
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
