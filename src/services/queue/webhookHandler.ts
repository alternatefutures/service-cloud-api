/**
 * Webhook handler for QStash deployment job callbacks.
 *
 * Mounted at /queue/akash/step and /queue/phala/step in the main server.
 * Each call is signature-verified (in production) and dispatched to the
 * appropriate step handler.
 *
 * IMPORTANT: Steps are processed BEFORE the 200 response so QStash retries
 * on failure (transient DB errors, OOM, crashes). This is critical for
 * delivery guarantees — a fire-and-forget 200 + Retries:0 loses jobs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { verifyWebhookSignature, isQStashEnabled } from './qstashClient.js'
import { handleSubmitTx, handleCheckBids, handleCreateLease, handleSendManifest, handlePollUrls, handleFailure } from './akashSteps.js'
import { handleDeployCvm, handlePollStatus, handlePhalaFailure } from './phalaSteps.js'
import { handlePolicyExpiry } from '../policy/runtimeScheduler.js'
import type { AkashJobPayload, PhalaJobPayload, PolicyJobPayload } from './types.js'
import type { AkashStep, PhalaStep, PolicyStep } from './types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('webhook-handler')

let _prisma: PrismaClient

export function initQueueHandler(prisma: PrismaClient) {
  _prisma = prisma
}

const MAX_BODY_BYTES = 256 * 1024 // 256KB — QStash payloads are small JSON

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// Payload validation — runtime checks before trusting the cast
// ---------------------------------------------------------------------------

const AKASH_STEPS = new Set<AkashStep>([
  'SUBMIT_TX', 'CHECK_BIDS', 'CREATE_LEASE', 'SEND_MANIFEST', 'POLL_URLS', 'HANDLE_FAILURE',
])
const PHALA_STEPS = new Set<PhalaStep>(['DEPLOY_CVM', 'POLL_STATUS', 'HANDLE_FAILURE'])
const POLICY_STEPS = new Set<PolicyStep>(['EXPIRE_POLICY'])

function validateAkashPayload(raw: unknown): AkashJobPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Payload must be an object')
  const obj = raw as Record<string, unknown>
  if (typeof obj.step !== 'string' || !AKASH_STEPS.has(obj.step as AkashStep))
    throw new Error(`Invalid or missing Akash step: ${String(obj.step)}`)
  if (typeof obj.deploymentId !== 'string' || !obj.deploymentId)
    throw new Error('Missing deploymentId')
  if (obj.step === 'CREATE_LEASE') {
    if (typeof obj.provider !== 'string') throw new Error('CREATE_LEASE requires provider')
    if (typeof obj.gseq !== 'number') throw new Error('CREATE_LEASE requires gseq')
    if (typeof obj.oseq !== 'number') throw new Error('CREATE_LEASE requires oseq')
  }
  if (obj.step === 'HANDLE_FAILURE' && typeof obj.errorMessage !== 'string')
    throw new Error('HANDLE_FAILURE requires errorMessage')
  return raw as AkashJobPayload
}

function validatePhalaPayload(raw: unknown): PhalaJobPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Payload must be an object')
  const obj = raw as Record<string, unknown>
  if (typeof obj.step !== 'string' || !PHALA_STEPS.has(obj.step as PhalaStep))
    throw new Error(`Invalid or missing Phala step: ${String(obj.step)}`)
  if (typeof obj.deploymentId !== 'string' || !obj.deploymentId)
    throw new Error('Missing deploymentId')
  return raw as PhalaJobPayload
}

function validatePolicyPayload(raw: unknown): PolicyJobPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Payload must be an object')
  const obj = raw as Record<string, unknown>
  if (typeof obj.step !== 'string' || !POLICY_STEPS.has(obj.step as PolicyStep))
    throw new Error(`Invalid or missing Policy step: ${String(obj.step)}`)
  if (typeof obj.policyId !== 'string' || !obj.policyId)
    throw new Error('Missing policyId')
  if (typeof obj.expectedExpiresAt !== 'string')
    throw new Error('Missing expectedExpiresAt')
  return raw as PolicyJobPayload
}

/**
 * Handle Akash step — can be called from QStash webhook or directly in local dev.
 */
export async function handleAkashStep(payload: AkashJobPayload): Promise<void> {
  switch (payload.step) {
    case 'SUBMIT_TX':
      return handleSubmitTx(_prisma, payload.deploymentId)
    case 'CHECK_BIDS':
      return handleCheckBids(_prisma, payload)
    case 'CREATE_LEASE':
      return handleCreateLease(_prisma, payload)
    case 'SEND_MANIFEST':
      return handleSendManifest(_prisma, payload)
    case 'POLL_URLS':
      return handlePollUrls(_prisma, payload)
    case 'HANDLE_FAILURE':
      return handleFailure(_prisma, payload)
    default:
      throw new Error(`Unknown Akash step: ${(payload as any).step}`)
  }
}

/**
 * Handle Phala step — can be called from QStash webhook or directly in local dev.
 */
export async function handlePhalaStep(payload: PhalaJobPayload): Promise<void> {
  switch (payload.step) {
    case 'DEPLOY_CVM':
      return handleDeployCvm(_prisma, payload.deploymentId)
    case 'POLL_STATUS':
      return handlePollStatus(_prisma, payload)
    case 'HANDLE_FAILURE':
      return handlePhalaFailure(_prisma, payload)
    default:
      throw new Error(`Unknown Phala step: ${(payload as any).step}`)
  }
}

/**
 * Handle policy runtime step — can be called from QStash webhook or directly in local dev.
 */
export async function handlePolicyStep(payload: PolicyJobPayload): Promise<void> {
  switch (payload.step) {
    case 'EXPIRE_POLICY':
      return handlePolicyExpiry(_prisma, payload)
    default:
      throw new Error(`Unknown policy step: ${(payload as any).step}`)
  }
}

/**
 * HTTP request handler for /queue/akash/step
 *
 * Processes the step BEFORE responding so QStash retries on failure.
 */
export async function handleAkashWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  let body: string
  try {
    body = await readBody(req)
  } catch {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }

  if (isQStashEnabled()) {
    const signature = req.headers['upstash-signature'] as string
    if (!signature) {
      sendJson(res, 401, { error: 'Missing signature' })
      return
    }
    const valid = await verifyWebhookSignature(signature, body)
    if (!valid) {
      sendJson(res, 401, { error: 'Invalid signature' })
      return
    }
  } else if (process.env.NODE_ENV === 'production') {
    log.error('QStash not configured in production — rejecting webhook')
    sendJson(res, 503, { error: 'Queue system not configured' })
    return
  }

  let payload: AkashJobPayload
  try {
    payload = validateAkashPayload(JSON.parse(body))
  } catch (err) {
    sendJson(res, 400, { error: `Invalid payload: ${(err as Error).message}` })
    return
  }

  try {
    await handleAkashStep(payload)
    sendJson(res, 200, { ok: true, step: payload.step })
  } catch (err) {
    log.error(err as Error, `Akash step ${payload.step} failed`)
    sendJson(res, 500, { error: 'Step processing failed', step: payload.step })
  }
}

/**
 * HTTP request handler for /queue/phala/step
 *
 * Processes the step BEFORE responding so QStash retries on failure.
 */
export async function handlePhalaWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  let body: string
  try {
    body = await readBody(req)
  } catch {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }

  if (isQStashEnabled()) {
    const signature = req.headers['upstash-signature'] as string
    if (!signature) {
      sendJson(res, 401, { error: 'Missing signature' })
      return
    }
    const valid = await verifyWebhookSignature(signature, body)
    if (!valid) {
      sendJson(res, 401, { error: 'Invalid signature' })
      return
    }
  } else if (process.env.NODE_ENV === 'production') {
    log.error('QStash not configured in production — rejecting webhook')
    sendJson(res, 503, { error: 'Queue system not configured' })
    return
  }

  let payload: PhalaJobPayload
  try {
    payload = validatePhalaPayload(JSON.parse(body))
  } catch (err) {
    sendJson(res, 400, { error: `Invalid payload: ${(err as Error).message}` })
    return
  }

  try {
    await handlePhalaStep(payload)
    sendJson(res, 200, { ok: true, step: payload.step })
  } catch (err) {
    log.error(err as Error, `Phala step ${payload.step} failed`)
    sendJson(res, 500, { error: 'Step processing failed', step: payload.step })
  }
}

/**
 * HTTP request handler for /queue/policy/expire
 *
 * Processes the step BEFORE responding so QStash retries on failure.
 */
export async function handlePolicyWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  let body: string
  try {
    body = await readBody(req)
  } catch {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }

  if (isQStashEnabled()) {
    const signature = req.headers['upstash-signature'] as string
    if (!signature) {
      sendJson(res, 401, { error: 'Missing signature' })
      return
    }
    const valid = await verifyWebhookSignature(signature, body)
    if (!valid) {
      sendJson(res, 401, { error: 'Invalid signature' })
      return
    }
  } else if (process.env.NODE_ENV === 'production') {
    log.error('QStash not configured in production — rejecting webhook')
    sendJson(res, 503, { error: 'Queue system not configured' })
    return
  }

  let payload: PolicyJobPayload
  try {
    payload = validatePolicyPayload(JSON.parse(body))
  } catch (err) {
    sendJson(res, 400, { error: `Invalid payload: ${(err as Error).message}` })
    return
  }

  try {
    await handlePolicyStep(payload)
    sendJson(res, 200, { ok: true, step: payload.step })
  } catch (err) {
    log.error(err as Error, `Policy step ${payload.step} failed`)
    sendJson(res, 500, { error: 'Step processing failed', step: payload.step })
  }
}
