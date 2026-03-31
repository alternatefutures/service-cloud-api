/**
 * Akash deployment step handlers for QStash background processing.
 *
 * Each function handles one discrete step, updates the DB, emits progress,
 * and enqueues the next step. Designed to be idempotent where possible.
 */

import type { PrismaClient } from '@prisma/client'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { publishJob, isQStashEnabled } from './qstashClient.js'
import { deploymentEvents } from '../events/deploymentEvents.js'
import { providerSelector } from '../akash/providerSelector.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'
import { scheduleOrEnforcePolicyExpiry } from '../policy/runtimeScheduler.js'
import { execAsync } from './asyncExec.js'
import {
  AKASH_TOTAL_STEPS,
  AKASH_STEP_NUMBERS,
  MAX_RETRY_COUNT,
  BID_POLL_MAX_ATTEMPTS,
  URL_POLL_MAX_ATTEMPTS,
  type AkashCheckBidsPayload,
  type AkashCreateLeasePayload,
  type AkashSendManifestPayload,
  type AkashPollUrlsPayload,
  type AkashHandleFailurePayload,
} from './types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('akash-steps')

const AKASH_CLI_TIMEOUT_MS = 120_000

const AKASH_TERMINAL_STATES = new Set([
  'ACTIVE',
  'CLOSED',
  'FAILED',
  'PERMANENTLY_FAILED',
  'SUSPENDED',
])

function getAkashEnv(): Record<string, string> {
  if (!process.env.AKASH_MNEMONIC) {
    throw new Error('AKASH_MNEMONIC is not set')
  }
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  return {
    ...(process.env as Record<string, string>),
    AKASH_KEY_NAME: keyName,
    AKASH_FROM: keyName,
    AKASH_KEYRING_BACKEND: 'test',
    AKASH_NODE: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
    AKASH_CHAIN_ID: process.env.AKASH_CHAIN_ID || 'akashnet-2',
    AKASH_GAS: 'auto',
    AKASH_GAS_ADJUSTMENT: '1.5',
    AKASH_GAS_PRICES: '0.025uakt',
    AKASH_BROADCAST_MODE: 'sync',
    AKASH_YES: 'true',
    HOME: process.env.HOME || '/home/nodejs',
  }
}

async function runAkashAsync(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): Promise<string> {
  const env = getAkashEnv()
  log.info(`Running: akash ${args.join(' ')}`)
  return execAsync('akash', args, { env, timeout })
}

async function runProviderServicesAsync(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): Promise<string> {
  const env = getAkashEnv()
  log.info(`Running: provider-services ${args.join(' ')}`)
  return execAsync('provider-services', args, { env, timeout })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* continue */
  }

  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx =
    objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
  if (startIdx === -1) {
    throw new SyntaxError(
      `No JSON found in CLI output: ${trimmed.slice(0, 200)}`
    )
  }
  return JSON.parse(trimmed.slice(startIdx))
}

function emitProgress(
  deploymentId: string,
  step: string,
  stepNumber: number,
  retryCount: number,
  message: string,
  errorMessage?: string
) {
  deploymentEvents.emitProgress({
    deploymentId,
    provider: 'akash',
    status: step,
    step,
    stepNumber,
    totalSteps: AKASH_TOTAL_STEPS,
    retryCount,
    message,
    errorMessage,
    timestamp: new Date().toISOString(),
  })
}

async function enqueueNext(
  path: string,
  body: Record<string, unknown>,
  delaySec?: number
) {
  if (isQStashEnabled()) {
    await publishJob(path, body, { delaySec })
  } else {
    const { handleAkashStep } = await import('./webhookHandler.js')
    if (delaySec) await new Promise(r => setTimeout(r, delaySec * 1000))
    await handleAkashStep(body as any)
  }
}

function isLikelyTcpUri(uri: string): boolean {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return false
  const parts = uri.split(':')
  if (parts.length < 2) return false
  const port = Number(parts.at(-1))
  if (Number.isNaN(port)) return false
  return port !== 80 && port !== 443
}

async function probeHttpUri(uri: string): Promise<boolean> {
  const candidates =
    uri.startsWith('http://') || uri.startsWith('https://')
      ? [uri]
      : [`https://${uri}`, `http://${uri}`]

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (response.status < 500) return true
    } catch {
      // Keep trying candidate URLs.
    }
  }

  return false
}

async function hasUsableEndpoint(
  services: Record<string, { uris: string[] }>
): Promise<boolean> {
  for (const service of Object.values(services)) {
    for (const uri of service.uris) {
      if (isLikelyTcpUri(uri)) return true
      if (await probeHttpUri(uri)) return true
    }
  }
  return false
}

/**
 * Last-resort: if enqueueNext for HANDLE_FAILURE itself fails, write FAILED
 * directly to the DB so the deployment doesn't hang forever.
 */
async function failDirectly(
  prisma: PrismaClient,
  deploymentId: string,
  errorMessage: string
): Promise<void> {
  try {
    const deployment = await prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      select: { dseq: true },
    })

    if (deployment?.dseq && Number(deployment.dseq) > 0) {
      try {
        await runAkashAsync([
          'tx', 'deployment', 'close',
          '--dseq', String(Number(deployment.dseq)),
          '-o', 'json', '-y',
        ])
      } catch (closeErr) {
        log.warn({ dseq: deployment.dseq, err: closeErr }, 'Failed to close on-chain deployment in failDirectly')
      }
    }

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: {
        status: 'FAILED',
        errorMessage: `[Queue failure] ${errorMessage}`,
      },
    })
    log.error(`Wrote FAILED directly for ${deploymentId} (enqueue failed)`)
  } catch (dbErr) {
    log.error({ err: dbErr }, `CRITICAL: Could not even write FAILED for ${deploymentId}`)
  }
}

// ── Step 1: SUBMIT_TX ─────────────────────────────────────────────────

export async function handleSubmitTx(
  prisma: PrismaClient,
  deploymentId: string
): Promise<void> {
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      sdlContent: true,
      retryCount: true,
      depositUakt: true,
      status: true,
    },
  })
  if (!deployment) throw new Error(`Deployment not found: ${deploymentId}`)
  if (AKASH_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(
    deploymentId,
    'SUBMIT_TX',
    AKASH_STEP_NUMBERS.SUBMIT_TX,
    deployment.retryCount,
    'Submitting deployment transaction...'
  )

  const workDir = mkdtempSync(join(tmpdir(), 'akash-tx-'))
  const sdlPath = join(workDir, 'deploy.yaml')
  writeFileSync(sdlPath, deployment.sdlContent)

  try {
    const deposit = deployment.depositUakt
      ? Number(deployment.depositUakt)
      : 5000000
    const output = await runAkashAsync([
      'tx',
      'deployment',
      'create',
      sdlPath,
      '--deposit',
      `${deposit}uact`,
      '-o',
      'json',
      '-y',
    ])

    const result = extractJson(output) as Record<string, unknown>

    const txCode =
      typeof result.code === 'number'
        ? result.code
        : typeof result.code === 'string'
          ? parseInt(result.code as string, 10)
          : undefined
    if (txCode !== undefined && txCode !== 0) {
      const rawLog = (result.raw_log || result.rawLog || '') as string
      throw new Error(
        `Akash tx rejected (code ${txCode}): ${rawLog.slice(0, 300)}`
      )
    }

    let dseq: number | undefined

    const logs = result.logs as
      | Array<{
          events?: Array<{
            type: string
            attributes?: Array<{ key: string; value: string }>
          }>
        }>
      | undefined
    if (logs) {
      for (const entry of logs) {
        for (const event of entry.events || []) {
          const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
          if (dseqAttr) {
            dseq = parseInt(dseqAttr.value, 10)
            break
          }
        }
        if (dseq) break
      }
    }

    if (!dseq && result.txhash) {
      const delays = [8000, 6000, 6000, 8000, 8000]
      for (const delay of delays) {
        await new Promise(r => setTimeout(r, delay))
        try {
          const txOutput = await runAkashAsync(
            ['query', 'tx', result.txhash as string, '-o', 'json'],
            60_000
          )
          const txResult = extractJson(txOutput) as Record<string, unknown>

          const txLogs = txResult.logs as
            | Array<{
                events?: Array<{
                  type: string
                  attributes?: Array<{ key: string; value: string }>
                }>
              }>
            | undefined
          if (txLogs) {
            for (const entry of txLogs) {
              for (const event of entry.events || []) {
                const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
                if (dseqAttr) {
                  dseq = parseInt(dseqAttr.value, 10)
                  break
                }
              }
              if (dseq) break
            }
          }

          if (!dseq) {
            const tx = txResult.tx as
              | { body?: { messages?: Array<{ id?: { dseq?: string } }> } }
              | undefined
            const msgDseq = tx?.body?.messages?.[0]?.id?.dseq
            if (msgDseq) dseq = parseInt(msgDseq, 10)
          }

          if (dseq) break
        } catch (err) {
          log.warn({ detail: (err as Error).message?.slice(0, 120) }, 'tx query attempt failed, retrying...')
        }
      }
    }

    if (!dseq || isNaN(dseq) || dseq <= 0) {
      throw new Error(
        'Failed to extract dseq from deployment creation response'
      )
    }

    const keyName = process.env.AKASH_KEY_NAME || 'default'
    const ownerOutput = await runAkashAsync(
      ['keys', 'show', keyName, '-a'],
      15_000
    )
    const owner = ownerOutput.trim()

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { dseq: BigInt(dseq), owner, status: 'WAITING_BIDS' },
    })

    emitProgress(
      deploymentId,
      'SUBMIT_TX',
      AKASH_STEP_NUMBERS.SUBMIT_TX,
      deployment.retryCount,
      `Deployment created on-chain (dseq: ${dseq}). Waiting for bids...`
    )

    await enqueueNext(
      '/queue/akash/step',
      {
        step: 'CHECK_BIDS',
        deploymentId,
        attempt: 1,
      } satisfies AkashCheckBidsPayload,
      10
    )
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : 'Unknown error during tx submission'
    try {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: errMsg,
      } satisfies AkashHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
}

// ── Step 2: CHECK_BIDS ────────────────────────────────────────────────

export async function handleCheckBids(
  prisma: PrismaClient,
  payload: AkashCheckBidsPayload
): Promise<void> {
  const { deploymentId, attempt } = payload
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      owner: true,
      dseq: true,
      retryCount: true,
      status: true,
    },
  })
  if (!deployment || AKASH_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(
    deploymentId,
    'CHECK_BIDS',
    AKASH_STEP_NUMBERS.CHECK_BIDS,
    deployment.retryCount,
    `Checking for provider bids (attempt ${attempt}/${BID_POLL_MAX_ATTEMPTS})...`
  )

  try {
    const dseq = Number(deployment.dseq)
    const output = await runAkashAsync([
      'query',
      'market',
      'bid',
      'list',
      '--owner',
      deployment.owner,
      '--dseq',
      String(dseq),
      '-o',
      'json',
    ])

    const result = extractJson(output) as {
      bids?: Array<Record<string, unknown>>
    }
    const rawBids = result.bids || []

    if (rawBids.length === 0) {
      if (attempt >= BID_POLL_MAX_ATTEMPTS) {
        await enqueueNext('/queue/akash/step', {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: 'No bids received within timeout',
        } satisfies AkashHandleFailurePayload)
        return
      }
      await enqueueNext(
        '/queue/akash/step',
        {
          step: 'CHECK_BIDS',
          deploymentId,
          attempt: attempt + 1,
        } satisfies AkashCheckBidsPayload,
        attempt * 5
      )
      return
    }

    const bids = rawBids.map(b => {
      const bid = (b as any).bid || b
      const bidId = bid.bid_id || bid.id || {}
      const price = bid.price || {}
      return {
        bidId: {
          provider: String(bidId.provider || ''),
          gseq: Number(bidId.gseq || 1),
          oseq: Number(bidId.oseq || 1),
        },
        price: {
          amount: String(price.amount || '0'),
          denom: String(price.denom || 'uact'),
        },
      }
    })

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'SELECTING_BID' },
    })

    const filteredBids = providerSelector.filterBids(bids as any, 'standalone')
    let safeBids = filteredBids.filter(b => b.isSafe)

    if (safeBids.length === 0) {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: 'No safe bids available - all providers are blocked',
      } satisfies AkashHandleFailurePayload)
      return
    }

    // ── Policy GPU filtering: filter bids by acceptable GPU models ──
    const policyDeployment = await prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      select: { policyId: true },
    })
    if (policyDeployment?.policyId) {
      const policy = await prisma.deploymentPolicy.findUnique({
        where: { id: policyDeployment.policyId },
      })
      if (policy && policy.acceptableGpuModels.length > 0) {
        const acceptable = new Set(policy.acceptableGpuModels.map(m => m.toLowerCase()))
        const gpuFilteredBids: typeof safeBids = []
        for (const bid of safeBids) {
          const model = await resolveProviderGpuModel(
            bid.bidId.provider,
            deployment.dseq,
            prisma,
            deploymentId
          )
          if (model && acceptable.has(model.toLowerCase())) {
            gpuFilteredBids.push(bid)
          }
        }
        if (gpuFilteredBids.length === 0) {
          await enqueueNext('/queue/akash/step', {
            step: 'HANDLE_FAILURE',
            deploymentId,
            errorMessage: `No providers offer the requested GPU models: ${policy.acceptableGpuModels.join(', ')}`,
          } satisfies AkashHandleFailurePayload)
          return
        }
        safeBids = gpuFilteredBids
        log.info(`Policy GPU filter: ${safeBids.length} bid(s) match acceptable models [${policy.acceptableGpuModels.join(', ')}]`)
      }
    }

    // If no preferred providers have bid yet and we haven't exhausted
    // polling attempts, wait for more bids before settling on unverified
    const hasPreferred = safeBids.some(b => providerSelector.isPreferredProvider(b.bidId.provider))
    if (!hasPreferred && attempt < BID_POLL_MAX_ATTEMPTS) {
      log.info(`${safeBids.length} bid(s) but none preferred — waiting for more (attempt ${attempt}/${BID_POLL_MAX_ATTEMPTS})`)
      await enqueueNext(
        '/queue/akash/step',
        {
          step: 'CHECK_BIDS',
          deploymentId,
          attempt: attempt + 1,
        } satisfies AkashCheckBidsPayload,
        5
      )
      return
    }

    const selectedBid = providerSelector.selectPreferredBid(safeBids)
    if (!selectedBid) {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: 'No bids remaining after preferred provider selection',
      } satisfies AkashHandleFailurePayload)
      return
    }

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: {
        provider: selectedBid.bidId.provider,
        gseq: selectedBid.bidId.gseq,
        oseq: selectedBid.bidId.oseq,
        pricePerBlock: selectedBid.price.amount,
        status: 'CREATING_LEASE',
      },
    })

    const isPreferred = providerSelector.isPreferredProvider(selectedBid.bidId.provider)
    emitProgress(
      deploymentId,
      'CHECK_BIDS',
      AKASH_STEP_NUMBERS.CHECK_BIDS,
      deployment.retryCount,
      `Selected ${isPreferred ? 'preferred' : 'unverified'} provider from ${safeBids.length} bid(s). Creating lease...`
    )

    await enqueueNext('/queue/akash/step', {
      step: 'CREATE_LEASE',
      deploymentId,
      provider: selectedBid.bidId.provider,
      gseq: selectedBid.bidId.gseq,
      oseq: selectedBid.bidId.oseq,
      priceAmount: selectedBid.price.amount,
    } satisfies AkashCreateLeasePayload)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error checking bids'
    try {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: errMsg,
      } satisfies AkashHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  }
}

// ── Helper: resolve provider GPU model from on-chain attributes ───────

async function resolveProviderGpuModel(
  providerAddr: string,
  dseq: bigint,
  prisma: PrismaClient,
  deploymentId: string
): Promise<string | null> {
  try {
    const deployment = await prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      select: { sdlContent: true },
    })
    if (deployment?.sdlContent) {
      const modelMatch = deployment.sdlContent.match(
        /gpu:[\s\S]*?model:\s*(\S+)/m
      )
      if (modelMatch?.[1] && modelMatch[1] !== 'nvidia') {
        return modelMatch[1]
      }
    }

    const output = await runAkashAsync(
      ['query', 'provider', 'get', providerAddr, '-o', 'json'],
      15_000
    )
    const result = extractJson(output) as {
      provider?: { attributes?: Array<{ key: string; value: string }> }
      attributes?: Array<{ key: string; value: string }>
    }
    const attrs = result.attributes || result.provider?.attributes || []

    for (const attr of attrs) {
      const gpuMatch = attr.key.match(
        /capabilities\/gpu\/vendor\/(\w+)\/model\/(\w+)/
      )
      if (gpuMatch?.[2]) return `${gpuMatch[1]}-${gpuMatch[2]}`
    }
  } catch (err) {
    log.warn({ detail: err instanceof Error ? err.message : err }, `Could not resolve GPU model for provider ${providerAddr}`)
  }
  return null
}

// ── Step 3: CREATE_LEASE ──────────────────────────────────────────────

export async function handleCreateLease(
  prisma: PrismaClient,
  payload: AkashCreateLeasePayload
): Promise<void> {
  const { deploymentId, provider, gseq, oseq } = payload
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      owner: true,
      dseq: true,
      retryCount: true,
      status: true,
    },
  })
  if (!deployment) return
  if (AKASH_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(
    deploymentId,
    'CREATE_LEASE',
    AKASH_STEP_NUMBERS.CREATE_LEASE,
    deployment.retryCount,
    'Creating lease with selected provider...'
  )

  try {
    const dseq = Number(deployment.dseq)
    await runAkashAsync([
      'tx',
      'market',
      'lease',
      'create',
      '--dseq',
      String(dseq),
      '--gseq',
      String(gseq),
      '--oseq',
      String(oseq),
      '--provider',
      provider,
      '-o',
      'json',
      '-y',
    ])

    await new Promise(r => setTimeout(r, 6000))

    const gpuModel = await resolveProviderGpuModel(
      provider,
      deployment.dseq,
      prisma,
      deploymentId
    )

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'SENDING_MANIFEST', ...(gpuModel ? { gpuModel } : {}) },
    })

    emitProgress(
      deploymentId,
      'CREATE_LEASE',
      AKASH_STEP_NUMBERS.CREATE_LEASE,
      deployment.retryCount,
      'Lease created. Sending manifest...'
    )

    await enqueueNext(
      '/queue/akash/step',
      {
        step: 'SEND_MANIFEST',
        deploymentId,
      } satisfies AkashSendManifestPayload,
      5
    )
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error creating lease'
    try {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: errMsg,
      } satisfies AkashHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  }
}

// ── Step 4: SEND_MANIFEST ─────────────────────────────────────────────

export async function handleSendManifest(
  prisma: PrismaClient,
  payload: AkashSendManifestPayload
): Promise<void> {
  const { deploymentId } = payload
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      dseq: true,
      provider: true,
      sdlContent: true,
      retryCount: true,
      status: true,
    },
  })
  if (!deployment || !deployment.provider) return
  if (AKASH_TERMINAL_STATES.has(deployment.status)) return

  emitProgress(
    deploymentId,
    'SEND_MANIFEST',
    AKASH_STEP_NUMBERS.SEND_MANIFEST,
    deployment.retryCount,
    'Sending deployment manifest to provider...'
  )

  const workDir = mkdtempSync(join(tmpdir(), 'akash-manifest-'))
  const sdlPath = join(workDir, 'deploy.yaml')
  writeFileSync(sdlPath, deployment.sdlContent)

  try {
    const dseq = Number(deployment.dseq)
    try {
      await runProviderServicesAsync([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        deployment.provider,
      ])
    } catch {
      await new Promise(r => setTimeout(r, 5000))
      await runProviderServicesAsync([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        deployment.provider,
      ])
    }

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'DEPLOYING' },
    })

    emitProgress(
      deploymentId,
      'SEND_MANIFEST',
      AKASH_STEP_NUMBERS.SEND_MANIFEST,
      deployment.retryCount,
      'Manifest sent. Waiting for service URLs...'
    )

    await enqueueNext(
      '/queue/akash/step',
      {
        step: 'POLL_URLS',
        deploymentId,
        attempt: 1,
      } satisfies AkashPollUrlsPayload,
      10
    )
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error sending manifest'
    try {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId,
        errorMessage: errMsg,
      } satisfies AkashHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deploymentId, errMsg)
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
}

// ── Step 5: POLL_URLS ─────────────────────────────────────────────────

export async function handlePollUrls(
  prisma: PrismaClient,
  payload: AkashPollUrlsPayload
): Promise<void> {
  const { deploymentId, attempt } = payload
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      service: { include: { afFunction: true, site: true, project: true } },
    },
  })
  if (
    !deployment ||
    !deployment.provider ||
    AKASH_TERMINAL_STATES.has(deployment.status)
  )
    return

  emitProgress(
    deploymentId,
    'POLL_URLS',
    AKASH_STEP_NUMBERS.POLL_URLS,
    deployment.retryCount,
    `Polling for service URLs (attempt ${attempt}/${URL_POLL_MAX_ATTEMPTS})...`
  )

  try {
    const dseq = Number(deployment.dseq)
    const output = await runProviderServicesAsync(
      [
        'lease-status',
        '--dseq',
        String(dseq),
        '--provider',
        deployment.provider,
      ],
      60_000
    )

    const result = extractJson(output) as {
      services?: Record<
        string,
        { uris?: string[]; available_replicas?: number }
      >
      forwarded_ports?: Record<
        string,
        Array<{
          host: string
          port: number
          externalPort: number
          proto: string
        }>
      >
    }
    const services = result.services || {}
    const forwardedPorts = result.forwarded_ports || {}
    const parsed: Record<string, { uris: string[] }> = {}
    for (const [k, v] of Object.entries(services)) {
      const uris = v.uris || []
      if (forwardedPorts[k]?.length) {
        for (const fp of forwardedPorts[k]) {
          uris.push(`${fp.host}:${fp.externalPort}`)
        }
      }
      parsed[k] = { uris }
    }
    const hasEndpoints = Object.values(parsed).some(s => s.uris.length > 0)
    const hasReadyReplicas = Object.values(services).some(
      s => (s.available_replicas ?? 0) > 0
    )

    // Deployment is ready when URIs are assigned and replicas are running.
    // HTTP probes are unreliable during container startup (502/503 from
    // provider ingress is normal while the app boots). The user can check
    // actual app health from the UI once the deployment is marked ACTIVE.
    const isReady = hasEndpoints && hasReadyReplicas

    if (!isReady) {
      if (attempt >= URL_POLL_MAX_ATTEMPTS) {
        const reason = hasEndpoints
          ? 'Deployment has URIs but container never started (0 replicas)'
          : 'Deployment never exposed any endpoints'
        await enqueueNext('/queue/akash/step', {
          step: 'HANDLE_FAILURE',
          deploymentId,
          errorMessage: reason,
        } satisfies AkashHandleFailurePayload)
        return
      }
      await enqueueNext(
        '/queue/akash/step',
        {
          step: 'POLL_URLS',
          deploymentId,
          attempt: attempt + 1,
        } satisfies AkashPollUrlsPayload,
        5
      )
      return
    }

    await finalizeDeploymentOrFail(prisma, deployment, parsed)
  } catch (err) {
    if (attempt >= URL_POLL_MAX_ATTEMPTS) {
      await finalizeDeploymentOrFail(prisma, deployment, {})
      return
    }
    await enqueueNext(
      '/queue/akash/step',
      {
        step: 'POLL_URLS',
        deploymentId,
        attempt: attempt + 1,
      } satisfies AkashPollUrlsPayload,
      5
    )
  }
}

async function finalizeDeploymentOrFail(
  prisma: PrismaClient,
  deployment: any,
  serviceUrls: Record<string, { uris: string[] }>
): Promise<void> {
  try {
    await finalizeDeployment(prisma, deployment, serviceUrls)
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : 'Error finalizing Akash deployment'
    try {
      await enqueueNext('/queue/akash/step', {
        step: 'HANDLE_FAILURE',
        deploymentId: deployment.id,
        errorMessage: errMsg,
      } satisfies AkashHandleFailurePayload)
    } catch {
      await failDirectly(prisma, deployment.id, errMsg)
    }
  }
}

export async function finalizeDeployment(
  prisma: PrismaClient,
  deployment: any,
  serviceUrls: Record<string, { uris: string[] }>
): Promise<void> {
  const organizationId = deployment.service?.project?.organizationId
  if (!organizationId) {
    throw new Error(
      `Cannot activate Akash deployment ${deployment.id} without organizationId`
    )
  }
  if (!deployment.pricePerBlock) {
    throw new Error(
      `Cannot activate Akash deployment ${deployment.id} without pricePerBlock`
    )
  }

  const escrowService = getEscrowService(prisma)
  const billingApi = getBillingApiClient()
  const orgBilling = await billingApi.getOrgBilling(organizationId)
  const orgMarkup = await billingApi.getOrgMarkup(orgBilling.orgBillingId)

  try {
    await escrowService.createEscrow({
      akashDeploymentId: deployment.id,
      organizationId,
      pricePerBlock: deployment.pricePerBlock,
      marginRate: orgMarkup.marginRate,
      userId: deployment.service?.createdByUserId
        || deployment.service?.project?.userId,
    })
  } catch (escrowErr) {
    const detail = escrowErr instanceof Error ? escrowErr.message : String(escrowErr)
    log.warn({ detail }, `Escrow creation failed for ${deployment.id}`)
    throw new Error(
      `Escrow creation failed for deployment ${deployment.id}: ${detail}`
    )
  }

  let gpuModelUpdate: string | undefined
  if (!deployment.gpuModel && deployment.provider && deployment.sdlContent) {
    const hasGpu = /gpu:/m.test(deployment.sdlContent)
    if (hasGpu) {
      const resolved = await resolveProviderGpuModel(
        deployment.provider,
        deployment.dseq,
        prisma,
        deployment.id
      )
      if (resolved) gpuModelUpdate = resolved
    }
  }

  await prisma.akashDeployment.update({
    where: { id: deployment.id },
    data: {
      status: 'ACTIVE',
      serviceUrls,
      deployedAt: new Date(),
      ...(gpuModelUpdate ? { gpuModel: gpuModelUpdate } : {}),
    },
  })

  if (deployment.policyId) {
    await scheduleOrEnforcePolicyExpiry(prisma, deployment.policyId)
  }

  const baseDomain = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'
  const protocol = baseDomain.includes('localhost') ? 'http' : 'https'
  const invokeUrl = `${protocol}://${deployment.service.slug}-app.${baseDomain}`

  if (deployment.service.type === 'FUNCTION' && deployment.service.afFunction) {
    await prisma.aFFunction.update({
      where: { id: deployment.service.afFunction.id },
      data: { status: 'ACTIVE', invokeUrl },
    })
  }

  emitProgress(
    deployment.id,
    'POLL_URLS',
    AKASH_STEP_NUMBERS.POLL_URLS,
    deployment.retryCount,
    'Deployment is now active!'
  )

  deploymentEvents.emitStatus({
    deploymentId: deployment.id,
    status: 'ACTIVE',
    timestamp: new Date(),
  })

  log.info(`Deployment ${deployment.id} is ACTIVE: ${invokeUrl}`)
}

// ── FAILURE handler ───────────────────────────────────────────────────

export async function handleFailure(
  prisma: PrismaClient,
  payload: AkashHandleFailurePayload
): Promise<void> {
  const { deploymentId, errorMessage } = payload
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    include: { service: { include: { afFunction: true } } },
  })
  if (!deployment) return

  // Guard: don't demote terminal states (stale/duplicate messages)
  if (AKASH_TERMINAL_STATES.has(deployment.status)) {
    log.warn(`Ignoring HANDLE_FAILURE for ${deploymentId} — already in terminal state ${deployment.status}`)
    return
  }

  const retryCount = deployment.retryCount

  await prisma.akashDeployment.update({
    where: { id: deploymentId },
    data: { status: 'FAILED', errorMessage },
  })

  emitProgress(
    deploymentId,
    'HANDLE_FAILURE',
    AKASH_STEP_NUMBERS.HANDLE_FAILURE,
    retryCount,
    `Deployment failed: ${errorMessage}`,
    errorMessage
  )

  if (retryCount < MAX_RETRY_COUNT) {
    log.info(`Retry ${retryCount + 1}/${MAX_RETRY_COUNT} for deployment ${deploymentId}`)

    if (deployment.dseq && Number(deployment.dseq) > 0) {
      try {
        await runAkashAsync([
          'tx',
          'deployment',
          'close',
          '--dseq',
          String(Number(deployment.dseq)),
          '-o',
          'json',
          '-y',
        ])
      } catch (closeErr) {
        log.warn({ detail: closeErr instanceof Error ? closeErr.message : closeErr }, 'Failed to close on-chain deployment for retry')
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
          },
        })

        retryPolicyId = retryPolicy.id
      }
    }

    const newDeployment = await prisma.akashDeployment.create({
      data: {
        owner: deployment.owner,
        dseq: BigInt(-Date.now()),
        sdlContent: deployment.sdlContent,
        serviceId: deployment.serviceId,
        afFunctionId: deployment.afFunctionId,
        siteId: deployment.siteId,
        depositUakt: deployment.depositUakt,
        gpuModel: deployment.gpuModel,
        status: 'CREATING',
        retryCount: retryCount + 1,
        parentDeploymentId: deployment.parentDeploymentId || deploymentId,
        policyId: retryPolicyId,
      },
    })

    emitProgress(
      newDeployment.id,
      'SUBMIT_TX',
      AKASH_STEP_NUMBERS.SUBMIT_TX,
      retryCount + 1,
      `Retrying deployment (attempt ${retryCount + 2}/${MAX_RETRY_COUNT + 1})...`
    )

    try {
      await enqueueNext(
        '/queue/akash/step',
        { step: 'SUBMIT_TX', deploymentId: newDeployment.id },
        5
      )
    } catch {
      await failDirectly(
        prisma,
        newDeployment.id,
        'Failed to enqueue retry step'
      )
    }
  } else {
    log.error(`Deployment ${deploymentId} permanently failed after ${MAX_RETRY_COUNT} retries`)

    // Close on-chain deployment to stop leaking AKT
    if (deployment.dseq && Number(deployment.dseq) > 0) {
      try {
        await runAkashAsync([
          'tx',
          'deployment',
          'close',
          '--dseq',
          String(Number(deployment.dseq)),
          '-o',
          'json',
          '-y',
        ])
      } catch (closeErr) {
        log.warn({ detail: closeErr instanceof Error ? closeErr.message : closeErr }, 'Failed to close on-chain deployment on permanent failure')
      }
    }

    await prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'PERMANENTLY_FAILED' as any },
    })

    if (
      deployment.service?.type === 'FUNCTION' &&
      deployment.service?.afFunction
    ) {
      await prisma.aFFunction.update({
        where: { id: deployment.service.afFunction.id },
        data: { status: 'FAILED' },
      })
    }

    deploymentEvents.emitStatus({
      deploymentId,
      status: 'PERMANENTLY_FAILED',
      timestamp: new Date(),
    })
  }
}
