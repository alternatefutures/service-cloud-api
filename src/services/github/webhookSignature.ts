/**
 * GitHub webhook HMAC SHA-256 verification.
 *
 * GitHub signs every webhook payload with the App's webhook secret using
 * HMAC SHA-256. We MUST verify before parsing — an unverified payload is
 * an unauthenticated POST from the public internet.
 *
 * Header: `X-Hub-Signature-256: sha256=<hex>`
 */

import crypto from 'node:crypto'
import { getGithubAppConfig } from './config.js'

/**
 * Verify a webhook payload signature. Uses constant-time comparison to
 * prevent timing oracles. Returns true iff signature matches.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const cfg = getGithubAppConfig()

  const hmac = crypto.createHmac('sha256', cfg.webhookSecret)
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
  const expected = `sha256=${hmac.digest('hex')}`

  // timingSafeEqual requires equal-length buffers; guard length first to
  // avoid throw-on-mismatch leaking the comparison to higher layers.
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
