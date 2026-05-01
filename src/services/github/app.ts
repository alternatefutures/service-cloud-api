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

/**
 * Drop a cached installation token. Call this immediately after we know the
 * installation no longer exists on GitHub (e.g. we just uninstalled it) so a
 * stale entry can never be handed out to a downstream caller.
 */
export function invalidateInstallationToken(installationId: bigint | string): void {
  installationTokenCache.delete(String(installationId))
}

/**
 * Uninstall the App from the account/org backing the given installation by
 * calling DELETE /app/installations/{installation_id} with a freshly-signed
 * App JWT. Equivalent to the user clicking "Uninstall" on github.com.
 *
 * GitHub returns 204 on success, 404 if the install was already removed
 * (treat as success — idempotent), or 401/403 on auth issues. Anything else
 * is surfaced to the caller; the local DB row is left intact in that case so
 * the user can retry. We let the existing `installation.deleted` webhook
 * (or our own caller-side cleanup) handle the local cleanup.
 */
export async function uninstallApp(installationId: bigint | string): Promise<void> {
  const key = String(installationId)
  const appJwt = getAppJwt()
  const r = await fetch(`https://api.github.com/app/installations/${key}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${appJwt}`,
      'User-Agent': 'AlternateFutures',
    },
  })
  // 204 No Content = uninstalled. 404 = already gone — DB and GitHub agree.
  if (r.status === 204 || r.status === 404) {
    invalidateInstallationToken(key)
    log.info({ installationId: key, status: r.status }, 'uninstalled App on GitHub')
    return
  }
  const body = await r.text().catch(() => '')
  throw new Error(
    `github: failed to uninstall App for installation ${key} (${r.status}): ${body.slice(0, 200)}`,
  )
}
