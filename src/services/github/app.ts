/**
 * GitHub App authentication helpers.
 *
 * Two token types matter for an App:
 *   1. App JWT  — short-lived (≤10 min), signed by the App's private key.
 *                 Used to call `/app/installations/...` to mint installation tokens.
 *   2. Installation token — short-lived (~1h), scoped to a single installation.
 *                 Used for everything else (clone, list repos, post statuses).
 *
 * We cache installation tokens in-process per installationId, refreshing 60s
 * before expiry. Multiple replicas each maintain their own cache; that's
 * fine because each token is independent and revoking is rarely needed.
 */

import jwt from 'jsonwebtoken'
import { createLogger } from '../../lib/logger.js'
import { getGithubAppConfig } from './config.js'

const log = createLogger('github.app')

interface InstallationTokenCacheEntry {
  token: string
  expiresAt: number // unix ms
}
const installationTokenCache = new Map<string, InstallationTokenCacheEntry>()

/**
 * Sign a fresh App JWT. GitHub recommends 10-min max; we use 9 min and
 * cache nothing (cheap to compute, easy to reason about).
 */
export function getAppJwt(): string {
  const cfg = getGithubAppConfig()
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      iat: now - 60, // backdate 60s to absorb clock drift
      exp: now + 9 * 60,
      iss: cfg.appId,
    },
    cfg.privateKeyPem,
    { algorithm: 'RS256' },
  )
}

/**
 * Mint (or return cached) installation access token for a given installation.
 * GitHub returns these tokens with ~1h TTL; we refresh when <60s remain.
 */
export async function getInstallationToken(installationId: bigint | string): Promise<string> {
  const key = String(installationId)
  const cached = installationTokenCache.get(key)
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.token
  }

  const appJwt = getAppJwt()
  const r = await fetch(`https://api.github.com/app/installations/${key}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${appJwt}`,
      'User-Agent': 'AlternateFutures',
    },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`github: failed to mint installation token (${r.status}): ${body.slice(0, 200)}`)
  }
  const data = (await r.json()) as { token: string; expires_at: string }
  const expiresAt = new Date(data.expires_at).getTime()
  installationTokenCache.set(key, { token: data.token, expiresAt })
  log.info({ installationId: key, expiresAt }, 'minted installation token')
  return data.token
}

/** Test-only — clears cached installation tokens. */
export function _resetInstallationTokenCache() {
  installationTokenCache.clear()
}
