/**
 * Build callback token — HMAC-signed one-time token the api hands the
 * builder Job; the builder echoes it back via `X-AF-Build-Token` when
 * POSTing status updates.
 *
 * Why not reuse JWT?
 *   - We don't need claims or expiry-based features; the BuildJob row
 *     itself is the source of truth (has expected status transitions).
 *   - Smaller wire format, deterministic, easy to inspect.
 *
 * Format:  base64url(payload).base64url(hmac256(payload))
 *   payload = `<buildJobId>.<unixSec>`
 *
 * Verification rules:
 *   - HMAC matches
 *   - buildJobId in payload matches the one in the request body
 *   - unixSec is within 4h of now (matches Job's activeDeadlineSeconds + slack)
 */

import crypto from 'node:crypto'

const MAX_AGE_SEC = 4 * 60 * 60 // 4h

function getSecret(): string {
  // Reuse JWT_SECRET (already shared between auth + cloud-api via deploy-secrets).
  // Falls back to GITHUB_APP_WEBHOOK_SECRET so local dev "just works" after
  // the manifest flow, even before deploy-secrets is run.
  const s = process.env.JWT_SECRET || process.env.GITHUB_APP_WEBHOOK_SECRET
  if (!s) throw new Error('build-token: neither JWT_SECRET nor GITHUB_APP_WEBHOOK_SECRET is set')
  return s
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export function signBuildToken(buildJobId: string): string {
  const payload = `${buildJobId}.${Math.floor(Date.now() / 1000)}`
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest()
  return `${b64url(payload)}.${b64url(sig)}`
}

export function verifyBuildToken(token: string, expectedBuildJobId: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payloadB64, sigB64] = parts
  const payload = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const sig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest()
  if (sig.length !== expected.length) return false
  if (!crypto.timingSafeEqual(sig, expected)) return false

  const [jobId, tsStr] = payload.split('.')
  if (jobId !== expectedBuildJobId) return false
  const ts = Number(tsStr)
  if (!Number.isFinite(ts)) return false
  const age = Math.floor(Date.now() / 1000) - ts
  if (age < -60 || age > MAX_AGE_SEC) return false

  return true
}
