/**
 * QStash client singleton for publishing background deployment jobs.
 *
 * When QSTASH_TOKEN is missing (local dev), jobs fall through to a
 * synchronous in-process executor so the existing orchestrator behaviour
 * is preserved without requiring an Upstash account for development.
 */

import { Client, Receiver } from '@upstash/qstash'

let client: Client | null = null
let receiver: Receiver | null = null

function getCallbackBaseUrl(): string {
  const base = process.env.QSTASH_CALLBACK_BASE_URL
  if (!base) {
    throw new Error('QSTASH_CALLBACK_BASE_URL is not set')
  }
  return base.replace(/\/$/, '')
}

export function getQStashClient(): Client {
  if (!client) {
    const token = process.env.QSTASH_TOKEN
    if (!token) {
      throw new Error('QSTASH_TOKEN is not set — cannot use QStash in this environment')
    }
    client = new Client({ token })
  }
  return client
}

export function getQStashReceiver(): Receiver {
  if (!receiver) {
    const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY
    const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY
    if (!currentKey || !nextKey) {
      throw new Error('QSTASH signing keys are not configured')
    }
    receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey })
  }
  return receiver
}

/**
 * Whether QStash is available in the current environment.
 * In local dev, this returns false and the orchestrators use direct in-process execution.
 */
export function isQStashEnabled(): boolean {
  return !!(process.env.QSTASH_TOKEN && process.env.QSTASH_CALLBACK_BASE_URL)
}

/**
 * Publish a job to a QStash endpoint.
 * @param path - Webhook path relative to QSTASH_CALLBACK_BASE_URL (e.g. '/queue/akash/submit-tx')
 * @param body - JSON-serialisable payload
 * @param options.delaySec - Optional delay before delivery (seconds)
 * @returns QStash message ID
 */
export async function publishJob(
  path: string,
  body: Record<string, unknown>,
  options?: { delaySec?: number },
): Promise<string> {
  const qstash = getQStashClient()
  const url = `${getCallbackBaseUrl()}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (options?.delaySec && options.delaySec > 0) {
    headers['Upstash-Delay'] = `${options.delaySec}s`
  }

  // Disable QStash's built-in retries — we handle retry logic ourselves
  headers['Upstash-Retries'] = '0'

  const result = await qstash.publishJSON({
    url,
    body,
    headers,
  })

  console.log(`[QStash] Published job to ${path}: messageId=${result.messageId}`)
  return result.messageId
}

/**
 * Verify an incoming QStash webhook signature.
 * Returns true if valid, false if verification fails.
 */
export async function verifyWebhookSignature(
  signature: string,
  body: string,
): Promise<boolean> {
  try {
    const recv = getQStashReceiver()
    await recv.verify({ signature, body })
    return true
  } catch {
    return false
  }
}
