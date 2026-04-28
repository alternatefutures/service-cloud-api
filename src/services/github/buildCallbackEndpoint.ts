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

  const TERMINAL: ReadonlySet<BuildStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELED'] as const)
  const now = new Date()
  const newStatus = body.status as BuildStatus

  // Atomic idempotency + write. Two failure modes we explicitly handle:
  //
  //   (a) Two near-simultaneous callbacks with DIFFERENT terminal statuses
  //       (builder posts SUCCEEDED while a pod-deletion handler posts FAILED).
  //       We must never let the loser overwrite the winner.
  //
  //   (b) The SAME callback posted twice (curl retry, K8s Job restart, GitHub
  //       redelivery — surprisingly common). The DB write is harmlessly
  //       idempotent (same data), but ANY side-effect downstream — most
  //       importantly autoDeployAfterBuild — must run AT MOST ONCE. Otherwise
  //       you get N AkashDeployments per push.
  //
  // We split the CAS into two arms so we can distinguish:
  //   - `firstTransition` arm: status moved from non-terminal → newStatus.
  //     This is the WINNING callback — fire side-effects.
  //   - `idempotentRetry` arm: status was already newStatus. DB write is a
  //     no-op-equivalent (we still re-run it to refresh logs, but it's the
  //     same row); side-effects MUST NOT fire.
  //
  // Interactive transaction so the Service mirror only commits when the
  // BuildJob CAS wins.
  const txResult = await prisma.$transaction(async (tx) => {
    const buildJobData = {
      status: newStatus,
      logs: body.logs?.slice(0, 60_000) ?? job.logs ?? undefined,
      imageTag: body.imageTag ?? job.imageTag,
      detectedFramework: body.detectedFramework ?? job.detectedFramework,
      detectedPort: body.detectedPort ?? job.detectedPort,
      errorMessage: body.errorMessage?.slice(0, 4_000) ?? null,
      startedAt: newStatus === 'RUNNING' && !job.startedAt ? now : job.startedAt,
      finishedAt: TERMINAL.has(newStatus) ? now : null,
    }

    // Arm 1: first transition into newStatus.
    const firstTransition = await tx.buildJob.updateMany({
      where: {
        id: job.id,
        status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELED'] },
      },
      data: buildJobData,
    })
    if (firstTransition.count === 1) {
      await tx.service.update({
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
                // Use the detected port as the runtime container port if the
                // user hasn't pinned one explicitly. SDL generators read
                // containerPort.
                containerPort:
                  job.service.containerPort ?? body.detectedPort ?? job.detectedPort ?? null,
              }
            : {}),
        },
      })
      return { outcome: 'first-transition' as const }
    }

    // Arm 2: idempotent retry of the SAME terminal status. Refresh logs but
    // do NOT touch Service (the original winning callback already did) and
    // do NOT signal side-effects.
    const idempotentRetry = await tx.buildJob.updateMany({
      where: { id: job.id, status: newStatus },
      data: { logs: buildJobData.logs },
    })
    if (idempotentRetry.count === 1) {
      return { outcome: 'idempotent-retry' as const }
    }

    return { outcome: 'terminal-mismatch' as const }
  })

  if (txResult.outcome === 'terminal-mismatch') {
    log.info(
      { buildJobId: job.id, current: job.status, incoming: body.status },
      'ignoring callback that would downgrade terminal status',
    )
    return reply(res, 200, { ok: true, ignored: 'terminal' })
  }
  if (txResult.outcome === 'idempotent-retry') {
    log.info(
      { buildJobId: job.id, status: body.status },
      'ignoring duplicate callback (same status as current) — side-effects already fired',
    )
    return reply(res, 200, { ok: true, ignored: 'duplicate' })
  }

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
  // Skipped when the service has autoDeploy=false — the build records the
  // new image and lastBuildSha so the user can deploy manually from the UI.
  if (newStatus === 'SUCCEEDED' && body.imageTag) {
    if (job.service.autoDeploy === false) {
      log.info({ serviceId: job.serviceId }, 'skipping auto-deploy: autoDeploy is disabled for service')
    } else {
      try {
        await autoDeployAfterBuild(prisma, job.serviceId)
      } catch (err) {
        log.error({ err, serviceId: job.serviceId }, 'failed to dispatch deploy after build')
        // We still 200 the callback — the BuildJob row is updated; the user
        // can hit "Redeploy" from the UI to retry the deploy step.
      }
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

  // Defense in depth against duplicate auto-deploys.
  //
  // The build-callback CAS gate above already filters duplicate SUCCEEDED
  // callbacks for a single BuildJob. But we can still be invoked twice for
  // the same service+image by orthogonal paths:
  //
  //   - Two BuildJobs for the same SHA (webhook redelivery slipping past the
  //     dedup window in webhookEndpoint, simultaneous push + manual rebuild,
  //     dual-instance race, etc.) each producing their own SUCCEEDED.
  //   - User clicking "Deploy" in the UI in the same second as the build's
  //     auto-deploy fires.
  //
  // Skip if there's already a non-terminal AkashDeployment for THIS service
  // created in the last 30s. The window is intentionally short — legitimate
  // redeploys (config change → redeploy) take longer than 30s of human input
  // anyway, and we'd rather the user occasionally hit "Redeploy" again than
  // double-charge them on every push.
  const DEDUP_WINDOW_MS = 30_000
  const inFlight = await prisma.akashDeployment.findFirst({
    where: {
      serviceId,
      status: { notIn: ['CLOSED', 'FAILED', 'PERMANENTLY_FAILED', 'SUSPENDED'] },
      createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
    },
    select: { id: true, status: true, createdAt: true },
  })
  if (inFlight) {
    log.info(
      { serviceId, existingDeploymentId: inFlight.id, existingStatus: inFlight.status },
      'skipping auto-deploy: in-flight deployment exists for service (deduped)',
    )
    return
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
