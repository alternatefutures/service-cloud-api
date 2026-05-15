/**
 * Spheron deployment step handlers for QStash background processing.
 *
 * Mirrors `phalaSteps.ts` line-for-line. Lifecycle:
 *
 *   DEPLOY_VM  → POST /api/deployments using the row's savedDeployInput.
 *                On success, persists `providerDeploymentId` + status=STARTING
 *                and enqueues POLL_STATUS. On retry, the resolver creates a
 *                fresh row with savedDeployInput cloned from the parent and
 *                re-enters this step.
 *   POLL_STATUS → GET /api/deployments/{id} until `status=running` and
 *                 `ipAddress` is populated. Persists ipAddress / sshUser /
 *                 sshPort. Status stays STARTING until RUN_CLOUDINIT_PROBE
 *                 confirms containers are up. Failure routes to HANDLE_FAILURE.
 *   RUN_CLOUDINIT_PROBE → SSH into the VM and `docker ps --format json` to
 *                          confirm at least one container is running. On
 *                          success: status → ACTIVE, activeStartedAt = now,
 *                          lastBilledAt = now, schedule policy expiry. On
 *                          attempt overflow: HANDLE_FAILURE.
 *   HANDLE_FAILURE → uniform failure handler (mirrors phala/akash). Includes
 *                    NON_RETRYABLE_ERRORS guard, MAX_RETRY_COUNT retry with
 *                    policy clone, user-cancelled-sibling check, failDirectly
 *                    fallback, upstream DELETE on permanent failure.
 *
 * Today we ship DEDICATED-only — SPOT (`status: terminated-provider`) is a
 * reserved code path. The PROVIDER_INTERRUPTED policy stop reason exists in
 * the schema but no step here emits it yet.
 */

import type { PrismaClient, SpheronDeploymentStatus } from '@prisma/client'

import { getSpheronClient, SpheronApiError } from '../spheron/client.js'
import {
  matchesStockShortage,
  markStockExhausted,
  getBlockReason,
} from '../spheron/stockBlocklist.js'
import { publishJob, isQStashEnabled } from './qstashClient.js'
import { deploymentEvents } from '../events/deploymentEvents.js'
import {
  SPHERON_TOTAL_STEPS,
  SPHERON_STEP_NUMBERS,
  MAX_RETRY_COUNT,
  SPHERON_POLL_MAX_ATTEMPTS,
  SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS,
  type SpheronPollStatusPayload,
  type SpheronRunCloudInitProbePayload,
  type SpheronHandleFailurePayload,
} from './types.js'
import { scheduleOrEnforcePolicyExpiry } from '../policy/runtimeScheduler.js'
import { getSpheronOrchestrator } from '../spheron/orchestrator.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-steps')

const SPHERON_TERMINAL_STATES = new Set<string>([
  'ACTIVE', 'FAILED', 'STOPPED', 'DELETED', 'PERMANENTLY_FAILED',
])

/**
 * Errors that should bypass MAX_RETRY_COUNT and go straight to
 * PERMANENTLY_FAILED. Each is matched as a case-insensitive substring of
 * the upstream error message.
 *
 * Stock-shortage patterns ('not enough stock', 'unable to launch',
 * 'sold out', 'out of stock') were added 2026-05-15 after the
 * `af-alternate-cyclic-bay-357-server` incident: the upstream catalog
 * advertised RTX-A4000 availability that no provider could actually
 * fulfil, and the prior retry classifier burned MAX_RETRY_COUNT attempts
 * hammering the same 400 response. Stock failures are persistent for the
 * lifetime of the blocklist entry (~15 min); retrying within that window
 * is guaranteed-futile.
 *
 * Keep this list aligned with `stockBlocklist.STOCK_SHORTAGE_REGEX` — every
 * stock-shortage pattern must appear here OR `matchesStockShortage` (used
 * below) must short-circuit before the substring check, so the two are
 * always consistent.
 */
const NON_RETRYABLE_ERRORS = [
  'insufficient balance',
  'no available capacity',
  'rate limit',
  'team not found',
  'invalid offer',
  'offer not available',
  // Stock shortage — see `stockBlocklist.matchesStockShortage` for the
  // authoritative regex; these substrings are the lowest-common-denominator
  // tokens for the substring matcher below.
  'not enough stock',
  'unable to launch',
  'sold out',
  'out of stock',
  'insufficient capacity',
]

function emitProgress(
  deploymentId: string,
  step: string,
  stepNumber: number,
  retryCount: number,
  message: string,
  errorMessage?: string,
) {
  deploymentEvents.emitProgress({
    deploymentId,
    provider: 'spheron',
    status: step,
    step,
    stepNumber,
    totalSteps: SPHERON_TOTAL_STEPS,
    retryCount,
    message,
    errorMessage,
    timestamp: new Date().toISOString(),
  })
}

async function enqueueNext(path: string, body: Record<string, unknown>, delaySec?: number) {
  if (isQStashEnabled()) {
    await publishJob(path, body, { delaySec })
  } else {
    const { handleSpheronStep } = await import('./webhookHandler.js')
    if (delaySec) await new Promise(r => setTimeout(r, delaySec * 1000))
    await handleSpheronStep(body as never)
  }
}

/**
 * Last-resort: if enqueueNext for HANDLE_FAILURE itself fails, write FAILED
 * directly to the DB so the deployment doesn't hang forever. Best-effort
 * upstream DELETE so we don't leak a paid VM.
 */
async function failDirectly(prisma: PrismaClient, deploymentId: string, errorMessage: string): Promise<void> {
  try {
    const deployment = await prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
      select: { providerDeploymentId: true },
    })

    if (deployment?.providerDeploymentId) {
      try {
        const orchestrator = getSpheronOrchestrator(prisma)
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
      } catch (delErr) {
        log.warn(
          { providerDeploymentId: deployment.providerDeploymentId, err: delErr },
          'Failed to delete Spheron deployment in failDirectly',
        )
      }
    }

    await prisma.spheronDeployment.update({
      where: { id: deploymentId },
      data: { status: 'FAILED', errorMessage: `[Queue failure] ${errorMessage}` },
    })
    log.error(`Wrote FAILED directly for ${deploymentId} (enqueue failed)`)
  } catch (dbErr) {
    log.error({ err: dbErr }, `CRITICAL: Could not even write FAILED for ${deploymentId}`)
  }
}

// ── Step 1: DEPLOY_VM ────────────────────────────────────────────────

/**
 * POST the savedDeployInput to Spheron, persist providerDeploymentId,
 * transition CREATING → STARTING, enqueue POLL_STATUS.
 *
 * Two entry shapes:
 *   1. Fresh deploy — resolver created the row with savedDeployInput set.
 *      providerDeploymentId is null. We POST and persist it.
 *   2. Retry — HANDLE_FAILURE created a new row with the parent's
 *      savedDeployInput cloned. Same flow as (1).
 *
 * If the row already has providerDeploymentId (idempotent re-entry) we
 * skip the POST and jump straight to enqueueing POLL_STATUS.
 */
export async function handleDeployVm(prisma: PrismaClient, deploymentId: string): Promise<void> {
  const deployment = await prisma.spheronDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)
  if (SPHERON_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(
    deploymentId,
    'DEPLOY_VM',
    SPHERON_STEP_NUMBERS.DEPLOY_VM,
    deployment.retryCount,
    'Submitting deploy request to Spheron...'
  )

  // Stock-blocklist short-circuit.
  //
  // If this SKU was rejected for capacity in the last ~15 min, the next
  // POST will almost certainly fail with the same upstream 400. Skip the
  // POST and route directly to HANDLE_FAILURE — that path matches the
  // NON_RETRYABLE_ERRORS list and emits PERMANENTLY_FAILED in one round-
  // trip instead of consuming MAX_RETRY_COUNT attempts. Critical on
  // process restart: `resumeStuckDeployments` re-fires DEPLOY_VM for any
  // CREATING row, and without this guard a single drained SKU floods
  // Spheron with retries every cloud-api restart.
  //
  // Only checked when there's no providerDeploymentId yet (i.e. we
  // haven't successfully POSTed). Idempotent re-entry below handles
  // already-POSTed rows.
  if (!deployment.providerDeploymentId) {
    const blockReason = getBlockReason(deployment.gpuType)
    if (blockReason) {
      const errMsg = `Spheron SKU ${deployment.gpuType} is temporarily out of stock. Latest upstream message: ${blockReason}`
      log.info(
        { deploymentId, gpuType: deployment.gpuType },
        'DEPLOY_VM: short-circuiting to HANDLE_FAILURE — SKU is currently blocklisted',
      )
      try {
        await enqueueNext(
          '/queue/spheron/step',
          { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies SpheronHandleFailurePayload,
        )
      } catch {
        await failDirectly(prisma, deploymentId, errMsg)
      }
      return
    }
  }

  // Idempotent re-entry: if we already have a providerDeploymentId, skip
  // the POST and re-enter the polling loop. This catches the QStash retry
  // case where the prior attempt POSTed successfully but crashed before
  // returning a 200 to QStash.
  if (deployment.providerDeploymentId) {
    log.info(
      { deploymentId, providerDeploymentId: deployment.providerDeploymentId },
      'DEPLOY_VM: providerDeploymentId already persisted — skipping POST and entering POLL_STATUS',
    )
    await enqueueNext(
      '/queue/spheron/step',
      { step: 'POLL_STATUS', deploymentId, attempt: 1 } satisfies SpheronPollStatusPayload,
      5,
    )
    return
  }

  if (!deployment.savedDeployInput) {
    const errMsg = 'savedDeployInput missing — cannot resume DEPLOY_VM'
    try {
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies SpheronHandleFailurePayload,
      )
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
    return
  }

  try {
    const client = getSpheronClient()
    if (!client) {
      throw new Error('Spheron is not configured (SPHERON_API_KEY missing)')
    }

    const created = await client.createDeployment(deployment.savedDeployInput as never)

    await prisma.spheronDeployment.update({
      where: { id: deploymentId },
      data: {
        providerDeploymentId: created.id,
        status: 'STARTING' as SpheronDeploymentStatus,
      },
    })

    emitProgress(
      deploymentId,
      'DEPLOY_VM',
      SPHERON_STEP_NUMBERS.DEPLOY_VM,
      deployment.retryCount,
      `VM provisioning (id: ${created.id}). Waiting for IP address...`,
    )

    await enqueueNext(
      '/queue/spheron/step',
      { step: 'POLL_STATUS', deploymentId, attempt: 1 } satisfies SpheronPollStatusPayload,
      5,
    )
  } catch (err) {
    // Surface the FULL Spheron payload — `err.message` alone is usually a
    // generic "Input payload validation failed", which tells us nothing
    // about which field broke. The structured `details` carries the real
    // server-side validation error.
    let errMsg = err instanceof Error ? err.message : 'Error deploying Spheron VM'
    if (err instanceof SpheronApiError && err.details) {
      try {
        const detailJson = typeof err.details === 'string'
          ? err.details
          : JSON.stringify(err.details)
        errMsg = `${errMsg} — details: ${detailJson.slice(0, 600)}`
      } catch {
        /* ignore */
      }
    }

    // Blocklist the SKU on any stock-shortage upstream response. This
    // hides the SKU from both the offer picker and the dropdown for the
    // blocklist TTL (~15 min) so subsequent deploys / page-loads don't
    // re-discover the same dead inventory. See `stockBlocklist.ts`.
    if (matchesStockShortage(errMsg) && deployment.gpuType) {
      markStockExhausted(deployment.gpuType, errMsg)
    }

    log.error(
      {
        deploymentId,
        err,
        details: err instanceof SpheronApiError ? err.details : undefined,
        sentName: (deployment.savedDeployInput as { name?: string } | null)?.name,
      },
      'DEPLOY_VM: Spheron POST failed',
    )
    try {
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies SpheronHandleFailurePayload,
      )
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  }
}

// ── Step 2: POLL_STATUS ──────────────────────────────────────────────

/**
 * Poll GET /api/deployments/{id} until `status=running && ipAddress`. Then
 * persist connection details and enqueue RUN_CLOUDINIT_PROBE. Status stays
 * STARTING until the cloudinit probe confirms containers are up — that
 * keeps billing off until the workload actually starts (contract:
 * activeStartedAt = lastBilledAt = ACTIVE transition).
 */
export async function handlePollStatus(prisma: PrismaClient, payload: SpheronPollStatusPayload): Promise<void> {
  const { deploymentId, attempt } = payload
  const deployment = await prisma.spheronDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment || SPHERON_TERMINAL_STATES.has(deployment.status)) return

  if (!deployment.providerDeploymentId) {
    // Race: POLL_STATUS fired before DEPLOY_VM persisted upstream id.
    // Re-queue once with a 5s delay; if it's still missing on a second
    // attempt, route to failure (likely a stuck DEPLOY_VM).
    if (attempt >= 2) {
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'HANDLE_FAILURE', deploymentId, errorMessage: 'POLL_STATUS reached without providerDeploymentId' } satisfies SpheronHandleFailurePayload,
      )
      return
    }
    await enqueueNext(
      '/queue/spheron/step',
      { step: 'POLL_STATUS', deploymentId, attempt: attempt + 1 } satisfies SpheronPollStatusPayload,
      5,
    )
    return
  }

  await prisma.spheronDeployment.update({
    where: { id: deploymentId },
    data: { updatedAt: new Date() },
  })

  emitProgress(
    deploymentId,
    'POLL_STATUS',
    SPHERON_STEP_NUMBERS.POLL_STATUS,
    deployment.retryCount,
    `Checking VM status (attempt ${attempt}/${SPHERON_POLL_MAX_ATTEMPTS})...`,
  )

  try {
    const client = getSpheronClient()
    if (!client) throw new Error('Spheron is not configured')

    const upstream = await client.getDeployment(deployment.providerDeploymentId)

    log.info(
      {
        deploymentId,
        attempt,
        upstreamStatus: upstream.status,
        ipAddress: upstream.ipAddress,
      },
      'POLL_STATUS: Spheron VM status check result',
    )

    if (upstream.status === 'running' && upstream.ipAddress) {
      // Defer ACTIVE transition (and billing start) until the cloudinit
      // probe confirms `docker ps` shows containers.
      await prisma.spheronDeployment.update({
        where: { id: deploymentId },
        data: {
          ipAddress: upstream.ipAddress,
          sshUser: upstream.user ?? 'ubuntu',
          sshPort: upstream.sshPort ?? 22,
        },
      })

      emitProgress(
        deploymentId,
        'POLL_STATUS',
        SPHERON_STEP_NUMBERS.POLL_STATUS,
        deployment.retryCount,
        `VM is up at ${upstream.ipAddress}. Probing container health...`,
      )

      await enqueueNext(
        '/queue/spheron/step',
        { step: 'RUN_CLOUDINIT_PROBE', deploymentId, attempt: 1 } satisfies SpheronRunCloudInitProbePayload,
        10,
      )
      return
    }

    if (upstream.status === 'failed') {
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'HANDLE_FAILURE', deploymentId, errorMessage: 'Spheron upstream returned status=failed' } satisfies SpheronHandleFailurePayload,
      )
      return
    }

    // SPOT reclaim — reserved for v2. v1 (DEDICATED) shouldn't see this,
    // but keep the path so a stray response routes to failure rather than
    // looping forever.
    if (upstream.status === 'terminated' || upstream.status === 'terminated-provider') {
      await enqueueNext(
        '/queue/spheron/step',
        {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: `Spheron upstream returned status=${upstream.status}`,
        } satisfies SpheronHandleFailurePayload,
      )
      return
    }

    if (attempt >= SPHERON_POLL_MAX_ATTEMPTS) {
      await enqueueNext(
        '/queue/spheron/step',
        {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: `VM did not reach running state within ${SPHERON_POLL_MAX_ATTEMPTS} polls (~10 min)`,
        } satisfies SpheronHandleFailurePayload,
      )
      return
    }

    await enqueueNext(
      '/queue/spheron/step',
      { step: 'POLL_STATUS', deploymentId, attempt: attempt + 1 } satisfies SpheronPollStatusPayload,
      5,
    )
  } catch (err) {
    // Treat upstream 404 mid-poll as a definitive failure — the VM is
    // gone before it ever reached running. Anything else: retry, route
    // to HANDLE_FAILURE only on attempt overflow.
    if (err instanceof SpheronApiError && err.status === 404) {
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'HANDLE_FAILURE', deploymentId, errorMessage: 'Spheron API returned 404 mid-poll — VM gone' } satisfies SpheronHandleFailurePayload,
      )
      return
    }

    if (attempt >= SPHERON_POLL_MAX_ATTEMPTS) {
      const errMsg = err instanceof Error ? err.message : 'Error polling Spheron VM status'
      try {
        await enqueueNext(
          '/queue/spheron/step',
          { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies SpheronHandleFailurePayload,
        )
      } catch {
        await failDirectly(prisma, deploymentId, errMsg)
      }
      return
    }
    await enqueueNext(
      '/queue/spheron/step',
      { step: 'POLL_STATUS', deploymentId, attempt: attempt + 1 } satisfies SpheronPollStatusPayload,
      5,
    )
  }
}

// ── Step 3: RUN_CLOUDINIT_PROBE ──────────────────────────────────────

/**
 * SSH into the VM and confirm at least one Docker container is running.
 * Cloud-init may still be installing Docker / pulling the image, so this
 * step retries every 5s for SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS
 * iterations (~5min default ceiling).
 *
 * On success: status → ACTIVE, activeStartedAt = now, lastBilledAt = now.
 * Billing starts here, NOT at POLL_STATUS — contract: lastBilledAt only
 * advances when the workload is actually running.
 */
export async function handleRunCloudInitProbe(
  prisma: PrismaClient,
  payload: SpheronRunCloudInitProbePayload,
): Promise<void> {
  const { deploymentId, attempt } = payload
  const deployment = await prisma.spheronDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment || SPHERON_TERMINAL_STATES.has(deployment.status)) return

  if (!deployment.ipAddress) {
    // Shouldn't happen — POLL_STATUS only enqueues RUN_CLOUDINIT_PROBE
    // after persisting ipAddress. Treat as a hard failure.
    await enqueueNext(
      '/queue/spheron/step',
      { step: 'HANDLE_FAILURE', deploymentId, errorMessage: 'RUN_CLOUDINIT_PROBE entered without ipAddress' } satisfies SpheronHandleFailurePayload,
    )
    return
  }

  emitProgress(
    deploymentId,
    'RUN_CLOUDINIT_PROBE',
    SPHERON_STEP_NUMBERS.RUN_CLOUDINIT_PROBE,
    deployment.retryCount,
    `Probing container health (attempt ${attempt}/${SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS})...`,
  )

  try {
    const orchestrator = getSpheronOrchestrator(prisma)
    const docker = await orchestrator.getDockerHealthViaSsh({
      ipAddress: deployment.ipAddress,
      sshUser: deployment.sshUser ?? 'ubuntu',
      sshPort: deployment.sshPort ?? 22,
    })

    // SSH transient — retry up to the cloudinit attempt ceiling.
    if (docker === null) {
      if (attempt >= SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS) {
        await enqueueNext(
          '/queue/spheron/step',
          {
            step: 'HANDLE_FAILURE',
            deploymentId,
            errorMessage: `cloudInit probe could not SSH after ${SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS} attempts (~${Math.round(SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS * 5 / 60)} min)`,
          } satisfies SpheronHandleFailurePayload,
        )
        return
      }
      await enqueueNext(
        '/queue/spheron/step',
        { step: 'RUN_CLOUDINIT_PROBE', deploymentId, attempt: attempt + 1 } satisfies SpheronRunCloudInitProbePayload,
        5,
      )
      return
    }

    if (docker.containers.length > 0) {
      const now = new Date()
      await prisma.spheronDeployment.update({
        where: { id: deploymentId },
        data: {
          status: 'ACTIVE' as SpheronDeploymentStatus,
          activeStartedAt: now,
          lastBilledAt: now,
        },
      })

      if (deployment.policyId) {
        await scheduleOrEnforcePolicyExpiry(prisma, deployment.policyId).catch(err => {
          log.warn(
            { deploymentId, policyId: deployment.policyId, err },
            'Failed to schedule Spheron policy expiry on activation',
          )
        })
      }

      emitProgress(
        deploymentId,
        'RUN_CLOUDINIT_PROBE',
        SPHERON_STEP_NUMBERS.RUN_CLOUDINIT_PROBE,
        deployment.retryCount,
        `VM is now ACTIVE (${docker.containers.length} container(s) running)!`,
      )
      deploymentEvents.emitStatus({ deploymentId, status: 'ACTIVE', timestamp: now })
      log.info({ deploymentId, ipAddress: deployment.ipAddress }, 'Spheron deployment ACTIVE')
      return
    }

    // SSH worked but `docker ps` shows nothing yet. Cloud-init may still
    // be installing Docker / pulling images. Retry until the ceiling.
    if (attempt >= SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS) {
      await enqueueNext(
        '/queue/spheron/step',
        {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: `No Docker containers running after ${SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS} cloudinit probes (~${Math.round(SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS * 5 / 60)} min)`,
        } satisfies SpheronHandleFailurePayload,
      )
      return
    }

    await enqueueNext(
      '/queue/spheron/step',
      { step: 'RUN_CLOUDINIT_PROBE', deploymentId, attempt: attempt + 1 } satisfies SpheronRunCloudInitProbePayload,
      5,
    )
  } catch (err) {
    if (attempt >= SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS) {
      const errMsg = err instanceof Error ? err.message : 'cloudInit probe error'
      try {
        await enqueueNext(
          '/queue/spheron/step',
          { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies SpheronHandleFailurePayload,
        )
      } catch {
        await failDirectly(prisma, deploymentId, errMsg)
      }
      return
    }
    await enqueueNext(
      '/queue/spheron/step',
      { step: 'RUN_CLOUDINIT_PROBE', deploymentId, attempt: attempt + 1 } satisfies SpheronRunCloudInitProbePayload,
      5,
    )
  }
}

// ── HANDLE_FAILURE ──────────────────────────────────────────────────

/**
 * Uniform failure handler. Mirrors handlePhalaFailure exactly:
 *
 *   - Terminal-state guard (don't demote from ACTIVE/DELETED/etc).
 *   - NON_RETRYABLE_ERRORS list bypasses retry → PERMANENTLY_FAILED.
 *   - User-cancelled-sibling check: if the user manually stopped a related
 *     deployment for the same service, abandon retry.
 *   - Up to MAX_RETRY_COUNT retries with a fresh policy clone (preserves
 *     time-limited fund reservation semantics).
 *   - Best-effort upstream DELETE on every retry / permanent-failure path
 *     so we don't leak a paid VM.
 *   - failDirectly fallback if enqueue itself fails.
 */
export async function handleSpheronFailure(
  prisma: PrismaClient,
  payload: SpheronHandleFailurePayload,
): Promise<void> {
  const { deploymentId, errorMessage } = payload
  const deployment = await prisma.spheronDeployment.findUnique({
    where: { id: deploymentId },
    include: { service: { include: { afFunction: true } } },
  })
  if (!deployment) return

  if (SPHERON_TERMINAL_STATES.has(deployment.status)) {
    log.warn(`Ignoring HANDLE_FAILURE for ${deploymentId} — already in terminal state ${deployment.status}`)
    return
  }

  const retryCount = deployment.retryCount
  const orchestrator = getSpheronOrchestrator(prisma)

  await prisma.spheronDeployment.update({
    where: { id: deploymentId },
    data: { status: 'FAILED' as SpheronDeploymentStatus, errorMessage },
  })

  emitProgress(
    deploymentId,
    'HANDLE_FAILURE',
    SPHERON_STEP_NUMBERS.HANDLE_FAILURE,
    retryCount,
    `Deployment failed: ${errorMessage}`,
    errorMessage,
  )

  const isNonRetryable = NON_RETRYABLE_ERRORS.some(pattern =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase()),
  )

  if (isNonRetryable) {
    log.info(`Non-retryable error for Spheron deployment ${deploymentId}: ${errorMessage}`)

    if (deployment.providerDeploymentId) {
      try {
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
      } catch (delErr) {
        log.warn(
          { providerDeploymentId: deployment.providerDeploymentId, err: delErr },
          'Failed to delete Spheron VM on non-retryable failure',
        )
      }
    }

    const userMessage = errorMessage.toLowerCase().includes('insufficient balance')
      ? 'Spheron team balance is too low to start this deployment. Top up the platform team or pick a cheaper offer.'
      : errorMessage

    await prisma.spheronDeployment.update({
      where: { id: deploymentId },
      data: { status: 'PERMANENTLY_FAILED' as SpheronDeploymentStatus, errorMessage: userMessage },
    })

    if (deployment.service?.type === 'FUNCTION' && deployment.service?.afFunction) {
      await prisma.aFFunction.update({
        where: { id: deployment.service.afFunction.id },
        data: { status: 'FAILED' },
      })
    }

    deploymentEvents.emitStatus({ deploymentId, status: 'PERMANENTLY_FAILED', timestamp: new Date() })
    return
  }

  if (retryCount < MAX_RETRY_COUNT) {
    // If the user manually stopped/deleted any deployment for this
    // service, abandon retry — they don't want this anymore.
    const userCancelled = await prisma.spheronDeployment.findFirst({
      where: {
        serviceId: deployment.serviceId,
        status: { in: ['STOPPED', 'DELETED'] },
      },
      select: { id: true },
    })
    if (userCancelled) {
      log.info(`Skipping retry for ${deploymentId} — user stopped/deleted a sibling Spheron deployment`)

      // Close the upstream VM before abandoning. The non-retryable and retry
      // branches both call closeDeployment; this branch used to skip it,
      // leaving a paid VM running on Spheron while our DB said
      // PERMANENTLY_FAILED — a billing leak.
      if (deployment.providerDeploymentId) {
        try {
          await orchestrator.closeDeployment(deployment.providerDeploymentId)
        } catch (delErr) {
          log.warn(
            { providerDeploymentId: deployment.providerDeploymentId, err: delErr },
            'Failed to delete Spheron VM in user-cancelled abandon path',
          )
        }
      }

      await prisma.spheronDeployment.update({
        where: { id: deploymentId },
        data: { status: 'PERMANENTLY_FAILED' as SpheronDeploymentStatus },
      })
      deploymentEvents.emitStatus({ deploymentId, status: 'PERMANENTLY_FAILED', timestamp: new Date() })
      return
    }

    log.info(`Retry ${retryCount + 1}/${MAX_RETRY_COUNT} for Spheron deployment ${deploymentId}`)

    if (deployment.providerDeploymentId) {
      try {
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
      } catch (delErr) {
        log.warn(
          { providerDeploymentId: deployment.providerDeploymentId, err: delErr },
          'Failed to delete Spheron VM for retry',
        )
      }
    }

    let retryPolicyId: string | undefined
    if (deployment.policyId) {
      const existingPolicy = await prisma.deploymentPolicy.findUnique({
        where: { id: deployment.policyId },
      })
      if (existingPolicy) {
        const retryPolicy = await prisma.deploymentPolicy.create({
          data: {
            acceptableGpuModels: existingPolicy.acceptableGpuModels,
            gpuUnits: existingPolicy.gpuUnits,
            gpuVendor: existingPolicy.gpuVendor,
            maxBudgetUsd: existingPolicy.maxBudgetUsd,
            maxMonthlyUsd: existingPolicy.maxMonthlyUsd,
            runtimeMinutes: existingPolicy.runtimeMinutes,
            expiresAt: existingPolicy.runtimeMinutes
              ? new Date(Date.now() + existingPolicy.runtimeMinutes * 60_000)
              : null,
            totalSpentUsd: existingPolicy.totalSpentUsd,
            allowedRegions: existingPolicy.allowedRegions,
            preferredRegions: existingPolicy.preferredRegions,
          },
        })
        retryPolicyId = retryPolicy.id
      }
    }

    // Spheron rejects duplicate VM names per team with
    // `400 Bad Request - This name is not available`, so we MUST regenerate
    // the upstream name on every retry. The retry suffix also makes the
    // upstream instance list easier to debug.
    //
    // IMPORTANT: derive from a CLEAN base name. Naïvely doing
    // `${deployment.name}-r${retryCount+1}-...` compounds suffixes across
    // retries (e.g. `…-r1-aaa-r2-bbb-r3-ccc`) and Spheron rejects names
    // beyond ~50 chars with 400 "Input payload validation failed". Strip
    // any trailing `-r<N>-<token>` chains before adding the new suffix.
    const baseName = deployment.name.replace(/(?:-r\d+-[a-z0-9]+)+$/, '')
    const retryName = `${baseName}-r${retryCount + 1}-${Date.now().toString(36)}`
    const retrySavedDeployInput =
      deployment.savedDeployInput && typeof deployment.savedDeployInput === 'object'
        ? { ...(deployment.savedDeployInput as Record<string, unknown>), name: retryName }
        : deployment.savedDeployInput

    const newDeployment = await prisma.spheronDeployment.create({
      data: {
        name: retryName,
        status: 'CREATING' as SpheronDeploymentStatus,
        provider: deployment.provider,
        offerId: deployment.offerId,
        gpuType: deployment.gpuType,
        gpuCount: deployment.gpuCount,
        region: deployment.region,
        operatingSystem: deployment.operatingSystem,
        instanceType: deployment.instanceType,
        sshKeyId: deployment.sshKeyId,
        savedCloudInit: deployment.savedCloudInit ?? undefined,
        savedDeployInput: (retrySavedDeployInput ?? undefined) as object | undefined,
        composeContent: deployment.composeContent,
        envKeys: deployment.envKeys ?? undefined,
        pricedSnapshotJson: deployment.pricedSnapshotJson ?? undefined,
        hourlyRateCents: deployment.hourlyRateCents,
        originalHourlyRateCents: deployment.originalHourlyRateCents,
        marginRate: deployment.marginRate,
        orgBillingId: deployment.orgBillingId,
        organizationId: deployment.organizationId,
        retryCount: retryCount + 1,
        parentDeploymentId: deployment.parentDeploymentId || deploymentId,
        policyId: retryPolicyId,
        serviceId: deployment.serviceId,
        siteId: deployment.siteId,
        afFunctionId: deployment.afFunctionId,
      },
    })

    emitProgress(
      newDeployment.id,
      'DEPLOY_VM',
      SPHERON_STEP_NUMBERS.DEPLOY_VM,
      retryCount + 1,
      `Retrying Spheron deployment (attempt ${retryCount + 2}/${MAX_RETRY_COUNT + 1})...`,
    )

    try {
      await enqueueNext('/queue/spheron/step', { step: 'DEPLOY_VM', deploymentId: newDeployment.id }, 5)
    } catch {
      await failDirectly(prisma, newDeployment.id, 'Failed to enqueue retry step')
    }
  } else {
    log.error(`Spheron deployment ${deploymentId} permanently failed after ${MAX_RETRY_COUNT} retries`)

    if (deployment.providerDeploymentId) {
      try {
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
      } catch (delErr) {
        log.warn(
          { providerDeploymentId: deployment.providerDeploymentId, err: delErr },
          'Failed to delete Spheron VM on permanent failure',
        )
      }
    }

    await prisma.spheronDeployment.update({
      where: { id: deploymentId },
      data: {
        status: 'PERMANENTLY_FAILED' as SpheronDeploymentStatus,
        errorMessage: `Permanently failed after ${MAX_RETRY_COUNT + 1} attempts: ${errorMessage}`,
      },
    })

    if (deployment.service?.type === 'FUNCTION' && deployment.service?.afFunction) {
      await prisma.aFFunction.update({
        where: { id: deployment.service.afFunction.id },
        data: { status: 'FAILED' },
      })
    }

    deploymentEvents.emitStatus({ deploymentId, status: 'PERMANENTLY_FAILED', timestamp: new Date() })
  }
}
