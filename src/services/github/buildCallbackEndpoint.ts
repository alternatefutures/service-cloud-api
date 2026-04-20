/**
 * `POST /internal/build-callback` — receives status updates from af-builder Jobs.
 *
 * The builder POSTs three times per Job:
 *   1. RUNNING   — when the daemon is up and clone starts
 *   2. SUCCEEDED — image pushed; payload includes imageTag, commitSha, detectedFramework, detectedPort
 *   3. FAILED    — anywhere along the way; payload includes errorMessage + truncated logs
 *
 * On SUCCEEDED we:
 *   - update BuildJob row + Service.dockerImage / detected* / lastBuildSha
 *   - post commit status `success` on GitHub
 *   - auto-deploy via the existing per-deploy provider mechanism:
 *       - rebuilds with an active deployment → use that provider
 *       - first build → fall back to Akash (matches the
 *         ServiceDetailPanel default at onDeploy → onDeployToAkash)
 *
 * The compute provider is NEVER stored on the Service row — it's the
 * same per-deploy choice every other flavor uses (Standard → Akash,
 * Confidential → Phala via ComputeMode picker). For first-deploy we
 * follow the panel's default; the user changes it later via
 * ComputeSelector + Redeploy, just like docker / server flavors.
 *
 * Auth: `X-AF-Build-Token` header is HMAC-signed with JWT_SECRET and bound
 * to the buildJobId in the body. Verified by `verifyBuildToken`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient, BuildStatus } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { verifyBuildToken } from './buildToken.js'
import { postCommitStatus } from './client.js'
import { akashMutations } from '../../resolvers/akash.js'
import { phalaMutations } from '../../resolvers/phala.js'
import type { Context } from '../../resolvers/types.js'

const log = createLogger('github.buildCallback')

interface CallbackBody {
  buildJobId?: string
  status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'
  logs?: string
  imageTag?: string
  commitSha?: string
  detectedFramework?: string
  detectedPort?: number | null
  errorMessage?: string
}

const VALID_STATUSES: ReadonlySet<BuildStatus> = new Set([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
] as const)

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 256 * 1024) {
      throw new Error('payload too large')
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw)
}

function reply(res: ServerResponse, status: number, body: object | string) {
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

export async function handleBuildCallback(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient,
): Promise<void> {
  if (req.method !== 'POST') return reply(res, 405, 'method not allowed')

  let body: CallbackBody
  try {
    body = (await readJson(req)) as CallbackBody
  } catch (err) {
    log.warn({ err }, 'invalid build-callback body')
    return reply(res, 400, 'invalid json')
  }

  if (!body.buildJobId || !body.status || !VALID_STATUSES.has(body.status as BuildStatus)) {
    return reply(res, 400, 'missing or invalid buildJobId/status')
  }

  const token = req.headers['x-af-build-token']
  const tokenStr = Array.isArray(token) ? token[0] : token
  if (!tokenStr || !verifyBuildToken(tokenStr, body.buildJobId)) {
    log.warn({ buildJobId: body.buildJobId }, 'rejected build-callback: bad/expired token')
    return reply(res, 401, 'invalid token')
  }

  const job = await prisma.buildJob.findUnique({
    where: { id: body.buildJobId },
    include: {
      service: {
        include: { project: true, gitInstallation: true },
      },
    },
  })
  if (!job) {
    log.warn({ buildJobId: body.buildJobId }, 'build-callback for unknown BuildJob')
    return reply(res, 404, 'build job not found')
  }

  // Idempotency: don't allow downgrading from a terminal status.
  const TERMINAL: ReadonlySet<BuildStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELED'] as const)
  if (TERMINAL.has(job.status) && job.status !== body.status) {
    log.info(
      { buildJobId: job.id, current: job.status, incoming: body.status },
      'ignoring callback that would downgrade terminal status',
    )
    return reply(res, 200, { ok: true, ignored: 'terminal' })
  }

  const now = new Date()
  const newStatus = body.status as BuildStatus

  // ── 1. Persist BuildJob update ──────────────────────────
  await prisma.buildJob.update({
    where: { id: job.id },
    data: {
      status: newStatus,
      logs: body.logs?.slice(0, 60_000) ?? job.logs ?? undefined,
      imageTag: body.imageTag ?? job.imageTag,
      detectedFramework: body.detectedFramework ?? job.detectedFramework,
      detectedPort: body.detectedPort ?? job.detectedPort,
      errorMessage: body.errorMessage?.slice(0, 4_000) ?? null,
      startedAt: newStatus === 'RUNNING' && !job.startedAt ? now : job.startedAt,
      finishedAt: TERMINAL.has(newStatus) ? now : null,
    },
  })

  // ── 2. Mirror status onto Service for fast UI reads ────
  await prisma.service.update({
    where: { id: job.serviceId },
    data: {
      lastBuildStatus: newStatus,
      lastBuildAt: now,
      lastBuildSha: body.commitSha ?? job.commitSha,
      ...(newStatus === 'SUCCEEDED' && body.imageTag
        ? {
            dockerImage: body.imageTag,
            detectedFramework: body.detectedFramework ?? job.detectedFramework,
            detectedPort: body.detectedPort ?? job.detectedPort,
            // Use the detected port as the runtime container port if the user
            // hasn't pinned one explicitly. SDL generators read containerPort.
            containerPort:
              job.service.containerPort ?? body.detectedPort ?? job.detectedPort ?? null,
          }
        : {}),
    },
  })

  // ── 3. Best-effort: write commit status back to GitHub ─
  if (job.service.gitInstallation && job.service.gitOwner && job.service.gitRepo) {
    const installationId = job.service.gitInstallation.installationId
    const targetUrl = `${process.env.APP_URL || 'https://app.alternatefutures.ai'}/services/${job.service.id}`
    void postCommitStatus(installationId, job.service.gitOwner, job.service.gitRepo, job.commitSha, {
      state:
        newStatus === 'SUCCEEDED'
          ? 'success'
          : newStatus === 'FAILED' || newStatus === 'CANCELED'
            ? 'failure'
            : 'pending',
      target_url: targetUrl,
      description:
        newStatus === 'SUCCEEDED'
          ? `Built on AlternateFutures (${body.detectedFramework ?? 'app'})`
          : newStatus === 'FAILED'
            ? body.errorMessage?.slice(0, 140) ?? 'Build failed'
            : 'Building…',
    }).catch((err) => log.warn({ err, buildJobId: job.id }, 'commit status post failed'))
  }

  // ── 4. On success, auto-deploy via existing per-deploy provider. ──
  if (newStatus === 'SUCCEEDED' && body.imageTag) {
    try {
      await autoDeployAfterBuild(prisma, job.serviceId)
    } catch (err) {
      log.error({ err, serviceId: job.serviceId }, 'failed to dispatch deploy after build')
      // We still 200 the callback — the BuildJob row is updated; the user
      // can hit "Redeploy" from the UI to retry the deploy step.
    }
  }

  return reply(res, 200, { ok: true, status: newStatus })
}

/**
 * Decide which compute provider to deploy the freshly-built image to,
 * then call the existing GraphQL deploy mutation. We deliberately call
 * the resolver functions (not provider.deploy()) so we inherit their
 * full guard stack — subscription, balance, policy, QStash pipeline —
 * without duplicating it.
 *
 * Provider choice mirrors what the ServiceDetailPanel "Deploy" button
 * does today (see ServiceDetailPanel.onDeploy):
 *   1. Active Phala deployment present → keep on Phala
 *   2. Otherwise → Akash (the panel's default fallback)
 *
 * The user retargets later via ComputeSelector + Redeploy, identical
 * to the docker / server / function flavors.
 */
async function autoDeployAfterBuild(prisma: PrismaClient, serviceId: string): Promise<void> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: {
      project: true,
      phalaDeployments: {
        where: { status: { in: ['ACTIVE', 'CREATING', 'STARTING'] } },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!service) throw new Error('service not found')
  if (!service.createdByUserId) {
    throw new Error('cannot deploy: service has no createdByUserId')
  }

  const ctx = {
    prisma,
    userId: service.createdByUserId,
    organizationId: service.project.organizationId ?? undefined,
    projectId: service.projectId,
  } as unknown as Context

  const useTee = service.phalaDeployments.length > 0
  log.info(
    { serviceId, provider: useTee ? 'phala' : 'akash' },
    'auto-deploying after successful build',
  )

  if (useTee) {
    await phalaMutations.deployToPhala(undefined, { input: { serviceId } }, ctx)
  } else {
    await akashMutations.deployToAkash(undefined, { input: { serviceId } }, ctx)
  }
}
