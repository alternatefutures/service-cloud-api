/**
 * `POST /webhooks/github` — receives GitHub App webhooks.
 *
 * Events we handle (everything else is ack'd 200 + ignored):
 *   - installation (created | deleted | suspend | unsuspend) → upsert/delete row
 *   - installation_repositories (added/removed) → no-op for now (UI re-fetches lazily)
 *   - push → if pushed branch matches any Service.gitBranch + repo, trigger rebuild
 *
 * MUST read raw body before JSON.parse for HMAC verification.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { isGithubAppConfigured } from './config.js'
import { verifyWebhookSignature } from './webhookSignature.js'
import { getCommit } from './client.js'
import { spawnBuildJob } from './buildSpawner.js'
import { getGithubAppConfig } from './config.js'

const log = createLogger('github.webhook')

function reply(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(body)
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 5 * 1024 * 1024) {
      throw new Error('webhook body too large')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface InstallationEvent {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted'
  installation: {
    id: number
    account: { login: string; id: number; type: 'User' | 'Organization' }
    repository_selection: 'all' | 'selected'
    suspended_at: string | null
  }
  sender: { id: number; login: string }
}

interface PushEvent {
  ref: string // refs/heads/<branch>
  after: string
  before: string
  repository: {
    id: number
    name: string
    full_name: string
    owner: { login: string; id: number }
    default_branch: string
  }
  installation?: { id: number }
  pusher: { name: string; email: string }
  head_commit: { id: string; message: string } | null
  deleted: boolean
}

export async function handleGithubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient,
): Promise<void> {
  if (req.method !== 'POST') return reply(res, 405, 'method not allowed')
  if (!isGithubAppConfigured()) {
    log.warn('rejecting webhook: GitHub App not configured')
    return reply(res, 503, 'github app not configured')
  }

  let raw: string
  try {
    raw = await readRawBody(req)
  } catch (err) {
    log.warn({ err }, 'failed to read webhook body')
    return reply(res, 413, 'payload too large')
  }

  const sig = req.headers['x-hub-signature-256']
  const sigStr = Array.isArray(sig) ? sig[0] : sig
  if (!verifyWebhookSignature(raw, sigStr)) {
    log.warn('rejecting webhook: signature mismatch')
    return reply(res, 401, 'bad signature')
  }

  const event = (req.headers['x-github-event'] as string | undefined) || ''
  const deliveryId = (req.headers['x-github-delivery'] as string | undefined) || ''

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return reply(res, 400, 'invalid json')
  }

  log.info({ event, deliveryId }, 'github webhook received')

  try {
    switch (event) {
      case 'ping':
        // GitHub sends ping right after install → just OK.
        return reply(res, 200, 'pong')

      case 'installation':
        await handleInstallationEvent(prisma, payload as InstallationEvent)
        return reply(res, 200, 'ok')

      case 'installation_repositories':
        // Repos added/removed from an installation. The UI re-fetches via
        // githubInstallationRepos when the user opens the picker, so we
        // don't need to materialize a copy. Just ack.
        return reply(res, 200, 'ok')

      case 'push':
        await handlePushEvent(prisma, payload as PushEvent)
        return reply(res, 200, 'ok')

      default:
        // We subscribed broadly in the manifest; ignore unrecognized events.
        return reply(res, 200, 'ignored')
    }
  } catch (err) {
    log.error({ err, event, deliveryId }, 'webhook handler crashed')
    // Returning 500 makes GitHub redeliver — useful for transient issues but
    // bad if we have a permanent bug. Compromise: 200 so we don't get
    // redelivery storms; the error is in the logs.
    return reply(res, 200, 'logged')
  }
}

// -----------------------------------------------------------------------
// installation event
// -----------------------------------------------------------------------

async function handleInstallationEvent(
  prisma: PrismaClient,
  payload: InstallationEvent,
): Promise<void> {
  const inst = payload.installation
  const installIdNum = BigInt(inst.id)

  if (payload.action === 'deleted') {
    // Hard-delete the row + all gitInstallationId pointers (Service rows fall
    // back to lastBuildSha-based deploys — they don't break, just can't redeploy).
    await prisma.service.updateMany({
      where: { gitInstallationId: { not: null } },
      data: {}, // no-op: we keep the FK set to null below
    })
    const local = await prisma.githubInstallation.findUnique({
      where: { installationId: installIdNum },
      select: { id: true },
    })
    if (local) {
      await prisma.service.updateMany({
        where: { gitInstallationId: local.id },
        data: { gitInstallationId: null },
      })
      await prisma.githubInstallation.delete({ where: { id: local.id } })
    }
    log.info({ installationId: inst.id }, 'installation deleted')
    return
  }

  if (payload.action === 'suspend' || payload.action === 'unsuspend') {
    await prisma.githubInstallation.updateMany({
      where: { installationId: installIdNum },
      data: { suspendedAt: payload.action === 'suspend' ? new Date() : null },
    })
    log.info({ installationId: inst.id, action: payload.action }, 'install suspension state updated')
    return
  }

  if (payload.action === 'created') {
    // We can't infer the org without prior context. The install came from a
    // user clicking "Install" on github.com directly (not the in-app flow).
    // Best-effort: try to match a `User.githubId` to set installedByUserId,
    // and require the user to call `syncGithubInstallation` from the in-app
    // setup_url to pick which org owns this install.
    //
    // For now: log only. The frontend will call `syncGithubInstallation`
    // when the user lands on /projects after the install redirect, and that
    // mutation does the upsert with the correct organizationId.
    log.info(
      { installationId: inst.id, account: inst.account.login },
      'install created (awaiting in-app sync)',
    )
    return
  }
}

// -----------------------------------------------------------------------
// push event
// -----------------------------------------------------------------------

async function handlePushEvent(prisma: PrismaClient, payload: PushEvent): Promise<void> {
  if (payload.deleted) return // branch deletion, not a push of new content
  if (!payload.installation?.id || !payload.head_commit) return

  const branch = payload.ref.startsWith('refs/heads/')
    ? payload.ref.slice('refs/heads/'.length)
    : null
  if (!branch) return // tag pushes not supported

  const installIdNum = BigInt(payload.installation.id)

  // Find every Service tracking this exact (installation, owner, repo, branch).
  const local = await prisma.githubInstallation.findUnique({
    where: { installationId: installIdNum },
    select: { id: true },
  })
  if (!local) {
    log.warn({ installationId: payload.installation.id }, 'push for unknown installation')
    return
  }

  const services = await prisma.service.findMany({
    where: {
      gitInstallationId: local.id,
      gitOwner: payload.repository.owner.login,
      gitRepo: payload.repository.name,
      gitBranch: branch,
    },
    select: {
      id: true,
      createdByUserId: true,
      gitOwner: true,
      gitRepo: true,
      gitBranch: true,
      rootDirectory: true,
      buildCommand: true,
      startCommand: true,
    },
  })

  if (services.length === 0) {
    log.info(
      { installationId: payload.installation.id, repo: payload.repository.full_name, branch },
      'push has no subscribed services',
    )
    return
  }

  log.info(
    { count: services.length, repo: payload.repository.full_name, branch, sha: payload.after },
    'push triggers rebuilds',
  )

  // Webhook redelivery dedup window. GitHub redelivers on ANY non-2xx and on
  // some "slow handler" heuristics — so the same logical push can arrive 2-5
  // times. Without this, every redelivery created another BuildJob, every
  // BuildJob fired autoDeployAfterBuild, and the user saw N AkashDeployments
  // for the same SHA. We can't add a UNIQUE(serviceId, commitSha) constraint
  // because legitimate "Rebuild" clicks for the same SHA are valid; instead
  // we look for any non-FAILED/CANCELED job for this (service, sha) created
  // recently, and treat that as proof a builder is already (or was just)
  // running.
  const DEDUP_WINDOW_MS = 5 * 60_000

  for (const svc of services) {
    try {
      const recent = await prisma.buildJob.findFirst({
        where: {
          serviceId: svc.id,
          commitSha: payload.after,
          status: { in: ['PENDING', 'RUNNING', 'SUCCEEDED'] },
          createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
        },
        select: { id: true, status: true, createdAt: true },
      })
      if (recent) {
        log.info(
          { serviceId: svc.id, commitSha: payload.after, existingBuildJobId: recent.id, existingStatus: recent.status },
          'dedup: skipping push-triggered build — existing recent BuildJob found (likely webhook redelivery)',
        )
        continue
      }

      const buildJob = await prisma.buildJob.create({
        data: {
          serviceId: svc.id,
          commitSha: payload.after,
          commitMessage: payload.head_commit.message.slice(0, 1000),
          branch,
          triggeredBy: `push:${payload.pusher.email || payload.pusher.name}`,
        },
      })

      if (!svc.createdByUserId) {
        log.warn({ serviceId: svc.id }, 'service has no createdByUserId — cannot tag image; skipping')
        continue
      }
      const cfg = getGithubAppConfig()
      // Docker registry refs MUST be all lowercase — userId is a Prisma cuid
      // (mixed case) and would break `docker build -t …` otherwise.
      const safeUserId = svc.createdByUserId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const safeOwner = svc.gitOwner!.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const safeRepo = svc.gitRepo!.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const imageTag = `ghcr.io/${cfg.ghcrNamespace}/${safeUserId}--${safeOwner}-${safeRepo}:${payload.after.slice(0, 12)}`

      const spawned = await spawnBuildJob({
        buildJobId: buildJob.id,
        installationId: installIdNum,
        repoOwner: svc.gitOwner!,
        repoName: svc.gitRepo!,
        commitSha: payload.after,
        imageTag,
        rootDirectory: svc.rootDirectory ?? undefined,
        buildCommand: svc.buildCommand ?? undefined,
        startCommand: svc.startCommand ?? undefined,
      })
      await prisma.buildJob.update({
        where: { id: buildJob.id },
        data: {
          k8sJobName: spawned.k8sJobName,
          status: 'RUNNING',
          logs: spawned.initialLog,
        },
      })
    } catch (err) {
      log.error({ err, serviceId: svc.id }, 'push-triggered rebuild failed to spawn')
      // Continue with the other services — one bad spawn shouldn't poison the batch.
    }
  }
}
