/**
 * `POST /internal/build-callback` — receives status updates from af-builder Jobs.
 *
 * The builder POSTs three times per Job: RUNNING (clone starts), SUCCEEDED
 * (image pushed; payload has imageTag, commitSha, detectedFramework,
 * detectedPort), FAILED (errorMessage + truncated logs).
 *
 * On SUCCEEDED we update BuildJob, sync Service.dockerImage/detected*
 * fields, post commit status to GitHub, and auto-deploy via the existing
 * per-deploy mutation. Provider choice mirrors the most recent active
 * deployment: Phala → Phala, Spheron → Spheron, otherwise Akash.
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
import { spheronMutations } from '../../resolvers/spheron.js'
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
 * then call the existing GraphQL deploy mutation. Calling the resolver
 * (not provider.deploy()) inherits its full guard stack — subscription,
 * balance, policy, QStash pipeline — without duplication.
 *
 * Provider choice: most-recent non-terminal deployment wins (Phala /
 * Spheron / Akash). When the service has never deployed, default to Akash
 * (matches ServiceDetailPanel's onDeploy default).
 */
async function autoDeployAfterBuild(prisma: PrismaClient, serviceId: string): Promise<void> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: {
      project: true,
      phalaDeployments: {
        where: { status: { in: ['ACTIVE', 'CREATING', 'STARTING'] } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      spheronDeployments: {
        where: { status: { in: ['ACTIVE', 'CREATING', 'STARTING'] } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })
  if (!service) throw new Error('service not found')
  if (!service.createdByUserId) {
    throw new Error('cannot deploy: service has no createdByUserId')
  }

  // Dedup against duplicate auto-deploys. The build-callback CAS gate above
  // filters duplicate SUCCEEDED callbacks for a single BuildJob, but two
  // BuildJobs for the same SHA (webhook redelivery, manual rebuild, dual
  // instance) or a user clicking "Deploy" the same second can still race.
  // 30s is short enough that genuine redeploys aren't blocked but long enough
  // to absorb the duplicate-callback window.
  const DEDUP_WINDOW_MS = 30_000
  const since = new Date(Date.now() - DEDUP_WINDOW_MS)
  const [akashInFlight, phalaInFlight, spheronInFlight] = await Promise.all([
    prisma.akashDeployment.findFirst({
      where: {
        serviceId,
        status: { notIn: ['CLOSED', 'FAILED', 'PERMANENTLY_FAILED', 'SUSPENDED'] },
        createdAt: { gte: since },
      },
      select: { id: true, status: true },
    }),
    prisma.phalaDeployment.findFirst({
      where: {
        serviceId,
        status: { notIn: ['STOPPED', 'FAILED', 'PERMANENTLY_FAILED'] },
        createdAt: { gte: since },
      },
      select: { id: true, status: true },
    }),
    prisma.spheronDeployment.findFirst({
      where: {
        serviceId,
        status: { notIn: ['STOPPED', 'FAILED', 'PERMANENTLY_FAILED', 'DELETED'] },
        createdAt: { gte: since },
      },
      select: { id: true, status: true },
    }),
  ])
  const inFlight = akashInFlight ?? phalaInFlight ?? spheronInFlight
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

  const phala = service.phalaDeployments[0]
  const spheron = service.spheronDeployments[0]
  let provider: 'akash' | 'phala' | 'spheron' = 'akash'
  if (phala && spheron) {
    provider = phala.createdAt >= spheron.createdAt ? 'phala' : 'spheron'
  } else if (phala) {
    provider = 'phala'
  } else if (spheron) {
    provider = 'spheron'
  }

  log.info({ serviceId, provider }, 'auto-deploying after successful build')

  if (provider === 'phala') {
    await phalaMutations.deployToPhala(undefined, { input: { serviceId } }, ctx)
  } else if (provider === 'spheron') {
    await spheronMutations.deployToSpheron(undefined, { input: { serviceId } }, ctx)
  } else {
    await akashMutations.deployToAkash(undefined, { input: { serviceId } }, ctx)
  }
}
