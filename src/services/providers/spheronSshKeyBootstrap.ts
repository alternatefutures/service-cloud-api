/**
 * Spheron SSH key bootstrap.
 *
 * On startup we ensure the platform's single shared SSH public key is
 * registered on Spheron under `SPHERON_SSH_KEY_NAME` (default
 * `af-platform-spheron`). The corresponding private key (held only in the
 * cloud-api pod's filesystem at `SPHERON_SSH_KEY_PATH`) is what
 * `services/spheron/orchestrator.ts` uses for every SSH-based shell, log,
 * and health probe.
 *
 * Locked decision:
 *   - Single platform-managed key for v1; per-user keys are deferred.
 *   - Bootstrap is **add-only** — never deletes existing keys, even on
 *     fingerprint mismatch (operator surface only).
 *   - Idempotent across cold-start cycles: name-match first, fingerprint
 *     check as a soft sanity verification (warn on mismatch).
 *
 * Single-pod assumption: the resolved key id lives in process memory.
 * When cloud-api scales to N replicas, replace with a Redis cache or a
 * `compute_provider` row keyed by `(provider_type=SPHERON, kind='ssh_key')`
 * — same pattern as the Akash hot-wallet bootstrap.
 *
 * Failure modes:
 *   - Missing `.pub` file → log warning + return null. The orchestrator's
 *     own `assertSshKeyExists` throws loudly on first SSH attempt — that
 *     is the correct cliff (deploys fail fast with a clear message).
 *   - SPHERON_API_KEY missing → log info + return null (provider disabled).
 *   - Spheron API down → log warning + return null. A later DEPLOY_VM
 *     attempt will throw with the real error. Bootstrap is best-effort.
 *
 * Operational rule honored:
 *   The platform private key is never injected into user-deployed
 *   containers, never persisted in DB rows visible to the user, never
 *   logged. Lives only in the cloud-api pod's filesystem.
 */

import { readFileSync, existsSync } from 'node:fs'

import { getSpheronClient } from '../spheron/client.js'
import { getSpheronSshKeyPath } from '../spheron/orchestrator.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-ssh-bootstrap')

let _cachedKeyId: string | null = null

/**
 * Cached after the first successful bootstrap. The orchestrator pulls
 * this when constructing the `POST /api/deployments` body.
 *
 * Returns null until `startSpheronSshKeyBootstrap()` succeeds.
 */
export function getCachedSpheronSshKeyId(): string | null {
  return _cachedKeyId
}

/**
 * Test-only reset hook so the bootstrap singleton plays nicely with the
 * suite's `beforeEach` cycles.
 */
export function resetCachedSpheronSshKeyId(): void {
  _cachedKeyId = null
}

/**
 * Resolve the public-key path from the configured private-key path.
 * Mirror the OpenSSH convention: `<privkey>.pub`.
 */
function getSpheronPublicKeyPath(): string {
  return `${getSpheronSshKeyPath()}.pub`
}

/**
 * Normalize an OpenSSH public-key string for bytewise comparison.
 * Compares only the algorithm + base64 key body — strips the optional
 * comment (third field) plus any trailing whitespace. Spheron sometimes
 * preserves the comment, sometimes not; the algorithm + key body is the
 * stable identity.
 */
function normalizePublicKey(publicKeyText: string): string {
  const parts = publicKeyText.trim().split(/\s+/)
  if (parts.length < 2) return publicKeyText.trim()
  return `${parts[0]} ${parts[1]}`
}

/**
 * One-shot bootstrap. Idempotent — safe to call on every cold start.
 * Returns the resolved Spheron SSH key id, or null when bootstrap was
 * skipped (no API key, no .pub file, transient API error).
 */
export async function startSpheronSshKeyBootstrap(): Promise<string | null> {
  const client = getSpheronClient()
  if (!client) {
    log.info('Spheron not configured (SPHERON_API_KEY missing) — skipping SSH key bootstrap')
    return null
  }

  const pubKeyPath = getSpheronPublicKeyPath()
  if (!existsSync(pubKeyPath)) {
    log.warn(
      { pubKeyPath },
      `Spheron public key file missing — Spheron deploys will fail at first SSH attempt. ` +
      `Generate one with: ssh-keygen -t ed25519 -f ${pubKeyPath.replace(/\.pub$/, '')} -C af-platform-spheron -N ""`,
    )
    return null
  }

  let publicKey: string
  try {
    publicKey = readFileSync(pubKeyPath, 'utf-8').trim()
  } catch (err) {
    log.warn({ pubKeyPath, err }, 'Failed to read Spheron public key — skipping bootstrap')
    return null
  }

  if (!publicKey.startsWith('ssh-')) {
    log.warn({ pubKeyPath, prefix: publicKey.slice(0, 20) }, 'Spheron public key does not look like an OpenSSH pubkey — skipping bootstrap')
    return null
  }

  const localNormalized = normalizePublicKey(publicKey)
  const keyName = process.env.SPHERON_SSH_KEY_NAME || 'af-platform-spheron'

  let existingKeys: Array<{ id: string; name: string; publicKey?: string; fingerprint?: string }>
  try {
    existingKeys = await client.listSshKeys()
  } catch (err) {
    log.warn({ err }, 'Spheron listSshKeys failed during bootstrap — first DEPLOY_VM will retry implicitly')
    return null
  }

  const existing = existingKeys.find(k => k.name === keyName)
  if (existing) {
    // Verify by bytewise public-key compare (Spheron's `fingerprint` field
    // is unreliable — observed 2026-05-06 to return a hash of the literal
    // string "ssh-ed25519 " rather than the actual key bytes). The list
    // endpoint may omit publicKey; in that case do an extra GET by id.
    let remotePublicKey = existing.publicKey
    if (!remotePublicKey) {
      try {
        const detail = await client.getSshKey(existing.id)
        remotePublicKey = detail.publicKey
      } catch (err) {
        log.warn(
          { err, keyId: existing.id },
          'Spheron getSshKey failed during bootstrap pubkey check — reusing existing id without verification',
        )
      }
    }

    if (remotePublicKey) {
      const remoteNormalized = normalizePublicKey(remotePublicKey)
      if (remoteNormalized !== localNormalized) {
        log.warn(
          {
            keyId: existing.id,
            keyName,
            // Show only the trailing chunk so we don't dump the full key into logs.
            remotePubKeyTail: remoteNormalized.slice(-12),
            localPubKeyTail: localNormalized.slice(-12),
          },
          'Spheron SSH key with our name exists but public key bytes differ — reusing existing id; SSH will likely fail at first shell',
        )
      }
    }

    _cachedKeyId = existing.id
    log.info(
      { keyId: existing.id, keyName },
      'spheron-ssh-bootstrap: reusing existing key',
    )
    return existing.id
  }

  // No matching key — create one. Surface failures verbatim so operators
  // can fix the underlying cause (rate-limited, team mismatch, etc.).
  try {
    const created = await client.createSshKey({ name: keyName, publicKey })
    _cachedKeyId = created.id
    log.info(
      { keyId: created.id, keyName, fingerprint: created.fingerprint },
      'spheron-ssh-bootstrap: registered new key',
    )
    return created.id
  } catch (err) {
    log.error({ err, keyName }, 'spheron-ssh-bootstrap: createSshKey failed')
    return null
  }
}
