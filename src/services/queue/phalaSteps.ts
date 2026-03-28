/**
 * Phala deployment step handlers for QStash background processing.
 */

import type { PrismaClient, PhalaDeploymentStatus } from '@prisma/client'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { publishJob, isQStashEnabled } from './qstashClient.js'
import { deploymentEvents } from '../events/deploymentEvents.js'
import { execAsync } from './asyncExec.js'
import {
  PHALA_TOTAL_STEPS,
  PHALA_STEP_NUMBERS,
  MAX_RETRY_COUNT,
  PHALA_POLL_MAX_ATTEMPTS,
  type PhalaPollStatusPayload,
  type PhalaHandleFailurePayload,
} from './types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('phala-steps')

const PHALA_TERMINAL_STATES = new Set<string>([
  'ACTIVE', 'FAILED', 'STOPPED', 'DELETED', 'PERMANENTLY_FAILED',
])

function getPhalaEnv(): Record<string, string> {
  const key = process.env.PHALA_API_KEY || process.env.PHALA_CLOUD_API_KEY
  if (!key) throw new Error('PHALA_API_KEY or PHALA_CLOUD_API_KEY is not set')
  return { ...(process.env as Record<string, string>), PHALA_CLOUD_API_KEY: key }
}

async function runPhalaAsync(args: string[], timeout = 120_000): Promise<string> {
  const env = getPhalaEnv()
  log.info(`Running: npx phala ${args.join(' ')}`)
  return execAsync('npx', ['phala', ...args], { env, timeout })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try { return JSON.parse(trimmed) } catch { /* continue */ }
  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
  if (startIdx === -1) throw new SyntaxError(`No JSON found: ${trimmed.slice(0, 200)}`)
  return JSON.parse(trimmed.slice(startIdx))
}

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
    provider: 'phala',
    status: step,
    step,
    stepNumber,
    totalSteps: PHALA_TOTAL_STEPS,
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
    const { handlePhalaStep } = await import('./webhookHandler.js')
    if (delaySec) await new Promise(r => setTimeout(r, delaySec * 1000))
    await handlePhalaStep(body as any)
  }
}

/**
 * Last-resort: if enqueueNext for HANDLE_FAILURE itself fails, write FAILED
 * directly to the DB so the deployment doesn't hang forever.
 */
async function failDirectly(prisma: PrismaClient, deploymentId: string, errorMessage: string): Promise<void> {
  try {
    await prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'FAILED', errorMessage: `[Queue failure] ${errorMessage}` },
    })
    log.error(`Wrote FAILED directly for ${deploymentId} (enqueue failed)`)
  } catch (dbErr) {
    log.error({ err: dbErr }, `CRITICAL: Could not even write FAILED for ${deploymentId}`)
  }
}

// ── Step 1: DEPLOY_CVM ───────────────────────────────────────────────

export async function handleDeployCvm(prisma: PrismaClient, deploymentId: string): Promise<void> {
  const deployment = await prisma.phalaDeployment.findUnique({
    where: { id: deploymentId },
    include: { service: { include: { envVars: true, project: { include: { services: { include: { envVars: true, ports: true } } } } } } },
  })
  if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)
  if (PHALA_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(deploymentId, 'DEPLOY_CVM', PHALA_STEP_NUMBERS.DEPLOY_CVM, deployment.retryCount, 'Deploying CVM to Phala Network...')

  const workDir = mkdtempSync(join(tmpdir(), 'phala-deploy-'))

  try {
    const composePath = join(workDir, 'docker-compose.yml')
    const envPath = join(workDir, '.env')

    writeFileSync(composePath, deployment.composeContent)

    const envVars: Record<string, string> = {}
    try {
      const { buildServiceMap, resolveEnvVars } = await import('../../utils/envInterpolation.js')
      const persistedVars = await prisma.serviceEnvVar.findMany({ where: { serviceId: deployment.serviceId } })
      if (persistedVars.length > 0) {
        const siblings = deployment.service?.project?.services || []
        const serviceMap = buildServiceMap(
          siblings.map((s: any) => ({
            slug: s.slug,
            internalHostname: s.internalHostname,
            envVars: s.envVars.map((e: any) => ({ key: e.key, value: e.value })),
            ports: s.ports.map((p: any) => ({ containerPort: p.containerPort, publicPort: p.publicPort })),
          })),
        )
        const resolved = resolveEnvVars(
          persistedVars.map((v: any) => ({ key: v.key, value: v.value })),
          serviceMap,
        )
        for (const { key, value } of resolved) envVars[key] = value
      }
    } catch (err) {
      log.warn(err as Error, 'Failed to resolve persisted env vars')
    }

    const envLines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')
    writeFileSync(envPath, envLines)

    const deployArgs = ['deploy', '-n', deployment.name, '-c', composePath]
    if (deployment.cvmSize) deployArgs.push('--instance-type', deployment.cvmSize)
    if (Object.keys(envVars).length > 0) deployArgs.push('-e', envPath)
    deployArgs.push('--json')

    const output = await runPhalaAsync(deployArgs)
    const result = extractJson(output) as Record<string, unknown>

    if (!result?.success) {
      throw new Error(String(result?.error || result?.message || 'Deploy failed'))
    }

    const appIdRaw = result.app_id || result.appId || result.vm_uuid
    if (!appIdRaw) throw new Error('Deploy succeeded but no app_id returned')
    const appId = String(appIdRaw)

    await prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { appId, status: 'STARTING' },
    })

    emitProgress(deploymentId, 'DEPLOY_CVM', PHALA_STEP_NUMBERS.DEPLOY_CVM, deployment.retryCount, `CVM created (app: ${appId}). Waiting for startup...`)

    await enqueueNext('/queue/phala/step', { step: 'POLL_STATUS', deploymentId, attempt: 1 } satisfies PhalaPollStatusPayload, 5)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error deploying CVM'
    try {
      await enqueueNext('/queue/phala/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: errMsg,
      } satisfies PhalaHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  } finally {
    try { rmSync(workDir, { recursive: true }) } catch { /* ignore */ }
  }
}

// ── Step 2: POLL_STATUS ──────────────────────────────────────────────

export async function handlePollStatus(prisma: PrismaClient, payload: PhalaPollStatusPayload): Promise<void> {
  const { deploymentId, attempt } = payload
  const deployment = await prisma.phalaDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment || PHALA_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(deploymentId, 'POLL_STATUS', PHALA_STEP_NUMBERS.POLL_STATUS, deployment.retryCount, `Checking CVM status (attempt ${attempt}/${PHALA_POLL_MAX_ATTEMPTS})...`)

  try {
    const output = await runPhalaAsync(['cvms', 'get', deployment.appId, '--json'], 15_000)
    const status = extractJson(output) as Record<string, unknown>

    if (status?.status === 'running') {
      const urls = (status.public_urls || status.publicUrls || []) as Array<{ app?: string } | string>
      const first = urls[0]
      const appUrl = typeof first === 'string' ? first : first?.app ?? null

      await prisma.phalaDeployment.update({
        where: { id: deploymentId },
        data: {
          status: 'ACTIVE' as PhalaDeploymentStatus,
          appUrl,
          activeStartedAt: new Date(),
          lastBilledAt: new Date(),
        },
      })

      emitProgress(deploymentId, 'POLL_STATUS', PHALA_STEP_NUMBERS.POLL_STATUS, deployment.retryCount, 'CVM is now active!')
      deploymentEvents.emitStatus({ deploymentId, status: 'ACTIVE', timestamp: new Date() })
      log.info(`Deployment ${deploymentId} is ACTIVE: ${appUrl}`)
      return
    }

    if (status?.status === 'failed' || status?.status === 'error') {
      const errMsg = typeof status.error === 'string' ? status.error : String(status.message || 'CVM failed')
      await enqueueNext('/queue/phala/step', { step: 'HANDLE_FAILURE', deploymentId, errorMessage: errMsg } satisfies PhalaHandleFailurePayload)
      return
    }

    if (attempt >= PHALA_POLL_MAX_ATTEMPTS) {
      await enqueueNext('/queue/phala/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: 'CVM did not start within timeout (2 minutes)',
      } satisfies PhalaHandleFailurePayload)
      return
    }

    await enqueueNext('/queue/phala/step', { step: 'POLL_STATUS', deploymentId, attempt: attempt + 1 } satisfies PhalaPollStatusPayload, 5)
  } catch (err) {
    if (attempt >= PHALA_POLL_MAX_ATTEMPTS) {
      const errMsg = err instanceof Error ? err.message : 'Error polling CVM status'
      try {
        await enqueueNext('/queue/phala/step', {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: errMsg,
        } satisfies PhalaHandleFailurePayload)
      } catch {
        await failDirectly(prisma, deploymentId, errMsg)
      }
      return
    }
    await enqueueNext('/queue/phala/step', { step: 'POLL_STATUS', deploymentId, attempt: attempt + 1 } satisfies PhalaPollStatusPayload, 5)
  }
}

// ── FAILURE handler ──────────────────────────────────────────────────

export async function handlePhalaFailure(prisma: PrismaClient, payload: PhalaHandleFailurePayload): Promise<void> {
  const { deploymentId, errorMessage } = payload
  const deployment = await prisma.phalaDeployment.findUnique({
    where: { id: deploymentId },
    include: { service: { include: { afFunction: true } } },
  })
  if (!deployment) return

  // Guard: don't demote terminal states (stale/duplicate messages)
  if (PHALA_TERMINAL_STATES.has(deployment.status)) {
    log.warn(`Ignoring HANDLE_FAILURE for ${deploymentId} — already in terminal state ${deployment.status}`)
    return
  }

  const retryCount = deployment.retryCount

  await prisma.phalaDeployment.update({
    where: { id: deploymentId },
    data: { status: 'FAILED', errorMessage },
  })

  emitProgress(deploymentId, 'HANDLE_FAILURE', PHALA_STEP_NUMBERS.HANDLE_FAILURE, retryCount, `Deployment failed: ${errorMessage}`, errorMessage)

  if (retryCount < MAX_RETRY_COUNT) {
    log.info(`Retry ${retryCount + 1}/${MAX_RETRY_COUNT} for Phala deployment ${deploymentId}`)

    if (deployment.appId && deployment.appId !== 'pending') {
      try {
        await runPhalaAsync(['cvms', 'delete', deployment.appId, '--force'], 30_000)
      } catch (delErr) {
        log.warn({ detail: delErr instanceof Error ? delErr.message : delErr }, 'Failed to delete CVM for retry')
      }
    }

    const newDeployment = await prisma.phalaDeployment.create({
      data: {
        appId: 'pending',
        name: deployment.name,
        status: 'CREATING',
        composeContent: deployment.composeContent,
        envKeys: deployment.envKeys ?? undefined,
        cvmSize: deployment.cvmSize,
        serviceId: deployment.serviceId,
        siteId: deployment.siteId,
        afFunctionId: deployment.afFunctionId,
        hourlyRateCents: deployment.hourlyRateCents,
        marginRate: deployment.marginRate,
        orgBillingId: deployment.orgBillingId,
        organizationId: deployment.organizationId,
        retryCount: retryCount + 1,
        parentDeploymentId: deployment.parentDeploymentId || deploymentId,
      },
    })

    emitProgress(newDeployment.id, 'DEPLOY_CVM', PHALA_STEP_NUMBERS.DEPLOY_CVM, retryCount + 1, `Retrying deployment (attempt ${retryCount + 2}/${MAX_RETRY_COUNT + 1})...`)

    try {
      await enqueueNext('/queue/phala/step', { step: 'DEPLOY_CVM', deploymentId: newDeployment.id }, 5)
    } catch {
      await failDirectly(prisma, newDeployment.id, 'Failed to enqueue retry step')
    }
  } else {
    log.error(`Phala deployment ${deploymentId} permanently failed after ${MAX_RETRY_COUNT} retries`)

    // Clean up the CVM on Phala Cloud
    if (deployment.appId && deployment.appId !== 'pending') {
      try {
        await runPhalaAsync(['cvms', 'delete', deployment.appId, '--force'], 30_000)
      } catch (delErr) {
        log.warn({ detail: delErr instanceof Error ? delErr.message : delErr }, 'Failed to delete CVM on permanent failure')
      }
    }

    await prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'PERMANENTLY_FAILED' as any, errorMessage: `Permanently failed after ${MAX_RETRY_COUNT + 1} attempts: ${errorMessage}` },
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
