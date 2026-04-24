/**
 * Akash Deployment Orchestrator
 *
 * Uses the `akash` CLI directly (execSync) for all Akash operations.
 * Mirrors PhalaOrchestrator style: stateless CLI calls, no persistent subprocess.
 *
 * Auth: AKASH_MNEMONIC env var for wallet access.
 * Provider auth: JWT (automatic in provider-services v0.10.0+, no certs needed).
 */

import { execSync, execFileSync, spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { Prisma } from '@prisma/client'
import type { PrismaClient, ServiceType } from '@prisma/client'
import type { ShellSession, LogStream } from '../providers/types.js'
import { providerSelector } from './providerSelector.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getAkashEnv } from '../../lib/akashEnv.js'
import { spawnLogStream } from './spawnLogStream.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'
import { createLogger } from '../../lib/logger.js'
import { withWalletLock, isWalletTx } from './walletMutex.js'
import type { TemplateGpu } from '../../templates/index.js'
import { resolveSdlPricingUact } from '../../templates/sdl.js'

const log = createLogger('akash-orchestrator')

const AKASH_CLI_TIMEOUT_MS = 120_000
const BID_POLL_INTERVAL_MS = 5000
const BID_POLL_MAX_ATTEMPTS = 10
const SERVICE_POLL_INTERVAL_MS = 5000
const SERVICE_POLL_MAX_ATTEMPTS = 24

/** Default Akash deposit in uact (1 ACT — buffer for bid/lease process). */
export const DEFAULT_DEPOSIT_UACT = 1_000_000

/**
 * Phase 38 — persistent volume attached to a raw Docker image. Mirrors the
 * shape used by `template.persistentStorage` so the SDL builders stay in sync.
 * Shape is also enforced by the `updateService` resolver before persistence,
 * but we re-validate at SDL build time as a defence-in-depth check (a
 * malformed entry slipping through makes Akash reject the entire deploy with
 * an opaque parse error).
 */
export interface ServiceVolume {
  name: string
  mountPath: string
  size: string
}

const VOLUME_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
const VOLUME_SIZE_RE = /^\d+(Mi|Gi|Ti)$/

export function parseServiceVolumes(raw: unknown): ServiceVolume[] {
  if (!Array.isArray(raw)) return []
  const out: ServiceVolume[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const name = String((entry as any).name ?? '').trim()
    const mountPath = String((entry as any).mountPath ?? '').trim()
    const size = String((entry as any).size ?? '').trim()
    if (!VOLUME_NAME_RE.test(name)) continue
    if (!mountPath.startsWith('/') || /\/$/.test(mountPath)) continue
    if (!VOLUME_SIZE_RE.test(size)) continue
    out.push({ name, mountPath, size })
  }
  return out
}

// Fixed by audit 2026-03: use execFileSync to prevent shell injection (was execSync with string concat)
function runAkash(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): string {
  const env = getAkashEnv()
  log.info(`Running: akash ${args.join(' ')}`)
  return execFileSync('akash', args, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Non-blocking version of runAkash for use in request handlers.
 * Uses execAsync to avoid freezing the Node.js event loop.
 *
 * If args[0] === 'tx' the call is serialized on the process-wide wallet
 * mutex to keep the Cosmos account sequence number monotonic. Read-only
 * commands (query, keys show, status) run without lock contention.
 */
async function runAkashAsync(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): Promise<string> {
  const { execAsync } = await import('../queue/asyncExec.js')
  const env = getAkashEnv()
  log.info(`Running (async): akash ${args.join(' ')}`)
  const invoke = () =>
    execAsync('akash', args, { env, timeout, maxBuffer: 10 * 1024 * 1024 })
  if (isWalletTx(args)) return withWalletLock(invoke)
  return invoke()
}

// ── Cosmos chain transaction helpers ─────────────────────────────────
//
// Every call to `akash tx <subcommand> ...` returns a JSON envelope of
// the form:
//
//   {
//     "code": 0,             // 0 = ABCI accepted, non-zero = chain rejected
//     "txhash": "...",       // tx hash; tx may still be pending inclusion
//     "raw_log": "...",      // human-readable error message when code != 0
//     "logs": [...],         // populated when broadcast mode = block
//     "height": "12345"      // populated only after block inclusion
//   }
//
// Historically each call site parsed this envelope inline, often
// silently treating "broadcast OK but chain rejected" as success.
// That class of bug — a `tx market lease create` that returned
// `code != 0` (e.g. bid taken by another lease, account-sequence
// mismatch) would happily proceed to the next step
// and mysteriously fail in a totally different place (manifest send,
// service URLs, etc.) hours later — with no telemetry pointing back
// to the rejected chain tx.
//
// `runAkashTxAsync` is the ONE entry-point for chain submissions:
//   1. forwards through the wallet mutex (via runAkashAsync)
//   2. parses the JSON envelope strictly
//   3. asserts code === 0 (throws AkashTxRejectedError otherwise)
//   4. waits for block inclusion by querying `akash query tx` if the
//      broadcast didn't already include it (sync-mode broadcasts).
//
// CI gate: `tools/check-no-raw-akash-tx.mjs` (also a vitest spec)
// prevents any new `runAkashAsync(['tx', ...])` call site from
// landing without going through this helper.

/**
 * Outcome of an Akash on-chain deployment close. See
 * `AkashOrchestrator.closeDeployment` for semantics.
 */
export type CloseDeploymentResult =
  | { chainStatus: 'CLOSED'; txhash: string }
  | { chainStatus: 'ALREADY_CLOSED'; reason: string }
  | { chainStatus: 'FAILED'; error: string }

/**
 * Substrings the Akash chain returns when a close was a no-op
 * because the deployment is already gone (closed by the provider,
 * never created, expired). Caller can safely treat these as success.
 */
const CLOSE_ALREADY_GONE_PATTERNS =
  /deployment closed|deployment not found|not active|does not exist|already closed/i

export class AkashTxRejectedError extends Error {
  readonly op: string
  readonly code: number
  readonly rawLog: string
  readonly txhash?: string
  constructor(op: string, code: number, rawLog: string, txhash?: string) {
    super(`${op}: tx rejected on-chain (code ${code}): ${rawLog.slice(0, 300)}`)
    this.name = 'AkashTxRejectedError'
    this.op = op
    this.code = code
    this.rawLog = rawLog
    this.txhash = txhash
  }
}

function parseTxCode(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const TX_INCLUSION_DELAYS_MS = [6000, 6000, 8000, 8000, 8000]

/**
 * Wait for a broadcast tx to be included in a block. Returns the
 * full `akash query tx` JSON once it's available. Throws if the
 * indexer never returns the tx (RPC lag, dropped from mempool, etc.).
 */
async function waitForTxInclusion(
  txhash: string,
  op: string,
): Promise<Record<string, unknown>> {
  for (const delay of TX_INCLUSION_DELAYS_MS) {
    await new Promise(r => setTimeout(r, delay))
    try {
      const txOutput = runAkash(
        ['query', 'tx', txhash, '-o', 'json'],
        15_000,
      )
      const txResult = extractJson(txOutput) as Record<string, unknown>
      const txCode = parseTxCode(txResult.code)
      if (txCode !== 0) {
        // Tx made it on-chain but the deliver-tx phase rejected it.
        const rawLog = (txResult.raw_log || txResult.rawLog || '') as string
        throw new AkashTxRejectedError(op, txCode, rawLog, txhash)
      }
      return txResult
    } catch (err) {
      if (err instanceof AkashTxRejectedError) throw err
      log.warn(
        `${op}: tx ${txhash} inclusion poll failed, retrying: ${
          (err as Error).message?.slice(0, 120)
        }`,
      )
    }
  }
  throw new Error(
    `${op}: tx ${txhash} not found after ${TX_INCLUSION_DELAYS_MS.length} polls — RPC indexer may be lagging`,
  )
}

export interface AkashTxResult {
  /** Hash of the broadcast transaction. */
  txhash: string
  /** Raw broadcast envelope (code, raw_log, logs, height). */
  broadcast: Record<string, unknown>
  /**
   * Confirmed envelope from `akash query tx <hash>`. Populated even
   * for sync-mode broadcasts where the broadcast envelope itself was
   * empty. Same shape as `broadcast` once the chain has indexed it.
   */
  confirmed: Record<string, unknown>
}

/**
 * Broadcast a chain tx through the wallet mutex, assert acceptance,
 * and wait for block inclusion.
 *
 * Every Akash `tx ...` call site MUST go through this helper.
 */
export async function runAkashTxAsync(
  args: string[],
  ctx: { op: string; meta?: Record<string, unknown> },
  timeout = AKASH_CLI_TIMEOUT_MS,
): Promise<AkashTxResult> {
  if (args[0] !== 'tx') {
    throw new Error(
      `runAkashTxAsync called with non-tx args (op=${ctx.op}): ${args.join(' ')}`,
    )
  }
  // Force JSON output and auto-confirm so callers can't accidentally
  // forget. Tolerate the flags already being present.
  const finalArgs = [...args]
  if (!finalArgs.includes('-o')) finalArgs.push('-o', 'json')
  if (!finalArgs.includes('-y')) finalArgs.push('-y')

  const output = await runAkashAsync(finalArgs, timeout)

  let broadcast: Record<string, unknown>
  try {
    broadcast = extractJson(output) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `${ctx.op}: tx broadcast returned unparseable output: ${
        (err as Error).message
      }`,
    )
  }

  const txhash = broadcast.txhash as string | undefined
  const code = parseTxCode(broadcast.code)
  if (code !== 0) {
    const rawLog = (broadcast.raw_log || broadcast.rawLog || '') as string
    log.error(
      { op: ctx.op, code, txhash, rawLog: rawLog.slice(0, 200), ...ctx.meta },
      `${ctx.op}: chain rejected tx`,
    )
    throw new AkashTxRejectedError(ctx.op, code, rawLog, txhash)
  }
  if (!txhash) {
    throw new Error(`${ctx.op}: tx accepted but broadcast envelope had no txhash`)
  }

  // If broadcast envelope already contains inclusion data (block-mode
  // broadcasts), short-circuit the inclusion wait.
  const heightStr = broadcast.height as string | number | undefined
  const height =
    typeof heightStr === 'number'
      ? heightStr
      : typeof heightStr === 'string'
        ? parseInt(heightStr, 10)
        : 0
  if (height > 0) {
    log.info(
      { op: ctx.op, txhash, height, ...ctx.meta },
      `${ctx.op}: tx accepted in block ${height}`,
    )
    return { txhash, broadcast, confirmed: broadcast }
  }

  const confirmed = await waitForTxInclusion(txhash, ctx.op)
  log.info(
    {
      op: ctx.op,
      txhash,
      height: confirmed.height,
      ...ctx.meta,
    },
    `${ctx.op}: tx included in block`,
  )
  return { txhash, broadcast, confirmed }
}

/**
 * Run provider-services CLI (used for manifest sending and lease operations).
 * Falls back to akash CLI if provider-services is not available.
 */
// Fixed by audit 2026-03: use execFileSync to prevent shell injection (was execSync with string concat)
function runProviderServices(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): string {
  const env = getAkashEnv()
  log.info(`Running: provider-services ${args.join(' ')}`)
  return execFileSync('provider-services', args, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Non-blocking provider-services call via child_process.spawn.
 * Used for log retrieval so the event loop isn't blocked during concurrent requests.
 */
function runProviderServicesAsync(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = getAkashEnv()
    const child = spawn('provider-services', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`provider-services timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `provider-services exited with code ${code}: ${stderr.slice(0, 500)}`
          )
        )
      }
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Extract the first JSON object or array from CLI output that may contain
 * non-JSON prefix text (e.g. "Broadcasting transaction...\n{...}").
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
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

function hasAnyServiceUris(serviceUrls: unknown): boolean {
  if (!serviceUrls || typeof serviceUrls !== 'object') return false
  return Object.values(serviceUrls as Record<string, { uris?: string[] }>).some(
    service => Array.isArray(service?.uris) && service.uris.length > 0
  )
}

/**
 * Emit an Akash SDL `credentials:` block (indented for nesting under
 * `services.<name>:`) for GHCR-hosted images. Returns the empty string
 * for images on other registries or when no token is configured — in
 * that case we fall back to the "image is public" assumption (either
 * intentionally, for templates pulling public base images, or as a
 * graceful failure mode that a human will notice in the provider logs).
 *
 * Security posture: the emitted token is shipped to the *winning
 * provider only* inside the manifest payload (NOT on-chain), but a
 * malicious provider can still exfiltrate whatever password we hand
 * them. We therefore STRONGLY prefer a dedicated read-only PAT
 * (`GHCR_PULL_TOKEN`). If we have to fall back to `GHCR_PUSH_TOKEN`
 * (which has `write:packages`), we log a loud warning so ops sees it.
 *
 * Usage site: prepended to the body of the service block in
 * generateCustomDockerSDL (and, if we extend it, the template generator).
 */
export function buildGhcrCredentialsBlock(image: string): string {
  if (!image.startsWith('ghcr.io/')) return ''

  const pullToken = process.env.GHCR_PULL_TOKEN || process.env.GHCR_PUSH_TOKEN
  if (!pullToken) {
    log.warn(
      { image },
      'GHCR image used but no GHCR_PULL_TOKEN/GHCR_PUSH_TOKEN configured — provider pulls will fail for private packages',
    )
    return ''
  }

  if (!process.env.GHCR_PULL_TOKEN && process.env.GHCR_PUSH_TOKEN) {
    // Rate-limited warning: log at most once per image per TTL window,
    // not every SDL regeneration, to avoid flooding logs on busy deploys.
    // Keyed on the image ref because same image = same leak surface.
    // Bounded with a TTL + size cap so we don't grow unbounded if a
    // misconfigured env stays broken for weeks across many image refs.
    const now = Date.now()
    const lastWarned = ghcrPullFallbackWarned.get(image)
    if (!lastWarned || now - lastWarned > GHCR_WARN_TTL_MS) {
      // Opportunistic eviction: drop expired entries when we touch the map,
      // and hard-cap size to prevent pathological growth in degraded mode.
      if (ghcrPullFallbackWarned.size > GHCR_WARN_MAX_ENTRIES) {
        for (const [k, ts] of ghcrPullFallbackWarned) {
          if (now - ts > GHCR_WARN_TTL_MS) ghcrPullFallbackWarned.delete(k)
        }
        // If still over cap after expiry sweep, clear the oldest half by
        // simply clearing the whole thing — re-warning is cheap.
        if (ghcrPullFallbackWarned.size > GHCR_WARN_MAX_ENTRIES) {
          ghcrPullFallbackWarned.clear()
        }
      }
      ghcrPullFallbackWarned.set(image, now)
      log.warn(
        { image },
        'Using GHCR_PUSH_TOKEN as pull credential — provider would gain write access if exfiltrated. Provision a read-only GHCR_PULL_TOKEN.',
      )
    }
  }

  // Username for GHCR PAT auth is a nonce; the token carries all the
  // auth signal. We use a neutral literal rather than leaking a human
  // identity (e.g. the owner of the push token).
  // `host:` must include the scheme per Akash SDL spec (see SDL Advanced
  // Features docs → "Private Container Registries"). Dropping the
  // `https://` prefix makes providers silently treat the manifest as
  // "no auth required" and ImagePullBackOff right back where we started.
  return `    credentials:
      host: https://ghcr.io
      username: af-deploy
      password: ${pullToken}
`
}

/**
 * Bounded TTL map so the GHCR_PUSH_TOKEN fallback warning doesn't spam logs
 * AND doesn't grow unbounded across many image refs in long-running
 * processes. Values are timestamps (ms epoch) of the last warn for that key.
 */
const GHCR_WARN_TTL_MS = 60 * 60 * 1000 // 1 hour
const GHCR_WARN_MAX_ENTRIES = 1000
const ghcrPullFallbackWarned = new Map<string, number>()

export class AkashOrchestrator {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get the Akash wallet address.
   * Uses async exec to avoid blocking the event loop in request handlers.
   */
  async getAccountAddress(): Promise<string> {
    const keyName = process.env.AKASH_KEY_NAME || 'default'
    const output = await runAkashAsync(['keys', 'show', keyName, '-a'], 15_000)
    return output.trim()
  }

  /**
   * Get wallet balances
   */
  async getBalances(
    address: string
  ): Promise<Array<{ denom: string; amount: string }>> {
    const output = runAkash(
      ['query', 'bank', 'balances', address, '-o', 'json'],
      15_000
    )
    const result = extractJson(output) as {
      balances?: Array<{ denom: string; amount: string }>
    }
    return result.balances || []
  }

  /**
   * Create a deployment on Akash
   */
  async createDeployment(
    sdlPath: string,
    deposit: number
  ): Promise<{ dseq: number; owner: string }> {
    log.info('Creating deployment...')
    const { broadcast, confirmed, txhash } = await runAkashTxAsync(
      [
        'tx', 'deployment', 'create', sdlPath,
        '--deposit', `${deposit}uact`,
      ],
      { op: 'createDeployment', meta: { deposit } },
    )
    log.info(
      `createDeployment tx confirmed: txhash=${txhash}, height=${confirmed.height}`,
    )

    // Walk both broadcast and confirmed envelopes for the dseq —
    // different akash CLI versions populate different shapes:
    //   * block-mode broadcast → broadcast.logs[].events[]
    //   * sync-mode broadcast  → confirmed.logs[].events[]
    //   * akash CLI v1.1.1+    → confirmed.tx.body.messages[0].id.dseq
    const candidates: Record<string, unknown>[] = [broadcast, confirmed]
    let dseq: number | undefined
    for (const candidate of candidates) {
      if (dseq) break
      const logs = candidate.logs as
        | Array<{
            events?: Array<{
              type: string
              attributes?: Array<{ key: string; value: string }>
            }>
          }>
        | undefined
      if (!logs) continue
      for (const entry of logs) {
        for (const event of entry.events || []) {
          if (
            event.type === 'akash.deployment.v1.EventDeploymentCreated' ||
            event.type === 'akash.v1beta3.EventDeploymentCreated' ||
            event.type === 'message'
          ) {
            const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
            if (dseqAttr) {
              dseq = parseInt(dseqAttr.value, 10)
              break
            }
          }
        }
        if (dseq) break
      }
    }

    if (!dseq) {
      const tx = confirmed.tx as
        | { body?: { messages?: Array<{ id?: { dseq?: string } }> } }
        | undefined
      const msgDseq = tx?.body?.messages?.[0]?.id?.dseq
      if (msgDseq) {
        dseq = parseInt(msgDseq, 10)
        log.info(`Parsed dseq from tx.body.messages: ${dseq}`)
      }
    }

    if (!dseq || isNaN(dseq) || dseq <= 0) {
      const safeResult = JSON.stringify(confirmed, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ).slice(0, 500)
      throw new Error(
        `Failed to create deployment: could not extract dseq from confirmed tx. Confirmed: ${safeResult}`,
      )
    }

    const owner = await this.getAccountAddress()
    log.info(
      `Deployment created: dseq=${dseq}, owner=${owner}`
    )
    return { dseq, owner }
  }

  /**
   * Top up an existing deployment's on-chain escrow.
   * Used after CREATE_LEASE when the actual price is known, to ensure
   * at least 1 hour of runway beyond the initial deposit.
   */
  async topUpDeploymentDeposit(dseq: number, amountUact: number): Promise<void> {
    if (amountUact <= 0) return
    log.info({ dseq, amountUact }, 'Topping up deployment escrow')
    const { txhash } = await runAkashTxAsync(
      [
        'tx', 'escrow', 'deposit', 'deployment',
        `${amountUact}uact`,
        '--dseq', String(dseq),
      ],
      { op: 'topUpDeploymentDeposit', meta: { dseq, amountUact } },
    )
    log.info({ dseq, amountUact, txhash }, 'Deployment escrow topped up')
  }

  /**
   * Get bids for a deployment
   */
  async getBids(
    owner: string,
    dseq: number
  ): Promise<
    Array<{
      bidId: { provider: string; gseq: number; oseq: number }
      price: { amount: string; denom: string }
      provider?: { hostUri?: string }
    }>
  > {
    const output = runAkash(
      [
        'query',
        'market',
        'bid',
        'list',
        '--owner',
        owner,
        '--dseq',
        String(dseq),
        '-o',
        'json',
      ],
      15_000
    )

    const result = extractJson(output) as {
      bids?: Array<{
        bid?: {
          bid_id?: Record<string, unknown>
          id?: Record<string, unknown>
          price?: Record<string, unknown>
        }
        bid_id?: Record<string, unknown>
        id?: Record<string, unknown>
        price?: Record<string, unknown>
      }>
    }

    if (!result.bids || result.bids.length === 0) {
      return []
    }

    return result.bids.map(b => {
      const bid = b.bid || b
      const bidId = (bid.bid_id || bid.id || {}) as Record<string, unknown>
      const price = (bid.price || {}) as Record<string, unknown>
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
  }

  /**
   * Create a lease with a provider.
   *
   * Goes through `runAkashTxAsync` so the chain's `code === 0`
   * acceptance is asserted and the tx's block inclusion is awaited
   * before we return. Previously this used a fire-and-forget
   * `runAkashAsync` followed by a 6-second `setTimeout` which
   * silently swallowed bid-taken / sequence-mismatch / insufficient-
   * funds rejections — those then surfaced hours later as
   * "manifest send failed" or "no service URLs" with no audit trail
   * pointing back to the dropped tx.
   */
  async createLease(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<void> {
    await runAkashTxAsync(
      [
        'tx',
        'market',
        'lease',
        'create',
        '--dseq', String(dseq),
        '--gseq', String(gseq),
        '--oseq', String(oseq),
        '--provider', provider,
      ],
      { op: 'createLease', meta: { owner, dseq, gseq, oseq, provider } },
    )
  }

  /**
   * Send manifest to provider
   */
  async sendManifest(
    sdlPath: string,
    dseq: number,
    provider: string
  ): Promise<void> {
    try {
      runProviderServices([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        provider,
      ])
    } catch (err) {
      // Fallback: retry once after a short delay (provider may not have lease ready)
      log.warn(
        `Manifest send failed, retrying in 5s: ${err instanceof Error ? err.message : err}`
      )
      await new Promise(r => setTimeout(r, 5000))
      runProviderServices([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        provider,
      ])
    }
  }

  /**
   * Get service URLs from provider
   */
  async getServices(
    dseq: number,
    provider: string
  ): Promise<Record<string, { uris: string[] }>> {
    const output = await runProviderServicesAsync(
      ['lease-status', '--dseq', String(dseq), '--provider', provider],
      15_000
    )

    const result = extractJson(output) as {
      services?: Record<string, { uris?: string[] }>
      forwarded_ports?: Record<
        string,
        Array<{ host: string; externalPort: number }>
      >
    }
    const services = result.services || {}
    const forwardedPorts = result.forwarded_ports || {}
    const out: Record<string, { uris: string[] }> = {}
    for (const [k, v] of Object.entries(services)) {
      const uris = [...(v.uris || [])]
      if (forwardedPorts[k]?.length) {
        for (const fp of forwardedPorts[k]) {
          uris.push(`${fp.host}:${fp.externalPort}`)
        }
      }
      out[k] = { uris }
    }
    return out
  }

  /**
   * Get per-container health from lease-status. Returns richer data than
   * getServices, including replica counts and container state.
   */
  async getLeaseHealth(
    dseq: number,
    provider: string
  ): Promise<Array<{
    name: string
    ready: boolean
    total: number
    available: number
    readyReplicas: number
    uris: string[]
  }>> {
    const output = await runProviderServicesAsync(
      ['lease-status', '--dseq', String(dseq), '--provider', provider],
      15_000
    )

    const result = extractJson(output) as {
      services?: Record<
        string,
        {
          name?: string
          uris?: string[]
          replicas?: number
          available_replicas?: number
          ready_replicas?: number
          updated_replicas?: number
        }
      >
      forwarded_ports?: Record<
        string,
        Array<{ host: string; externalPort: number }>
      >
    }

    const services = result.services || {}
    const forwardedPorts = result.forwarded_ports || {}
    const containers: Array<{
      name: string
      ready: boolean
      total: number
      available: number
      readyReplicas: number
      uris: string[]
    }> = []

    for (const [k, v] of Object.entries(services)) {
      const uris = [...(v.uris || [])]
      if (forwardedPorts[k]?.length) {
        for (const fp of forwardedPorts[k]) {
          uris.push(`${fp.host}:${fp.externalPort}`)
        }
      }
      const total = v.replicas ?? 1
      const available = v.available_replicas ?? 0
      const readyReplicas = v.ready_replicas ?? 0
      containers.push({
        name: k,
        ready: readyReplicas >= total && total > 0,
        total,
        available,
        readyReplicas,
        uris,
      })
    }

    return containers
  }

  /**
   * Background backfill for deployments where URIs weren't available during
   * the initial polling window. Retries every 10s for up to 3 minutes.
   */
  private async backfillServiceUrls(
    deploymentId: string,
    dseq: number,
    provider: string
  ): Promise<void> {
    const BACKFILL_INTERVAL_MS = 10_000
    const BACKFILL_MAX_ATTEMPTS = 18 // 18 * 10s = 3 minutes

    let consecutiveErrors = 0

    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, BACKFILL_INTERVAL_MS))

      // Check if the deployment is still ACTIVE (might have been closed)
      const dep = await this.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        select: { status: true, serviceUrls: true },
      })
      if (!dep || dep.status !== 'ACTIVE') {
        log.info(
          `Backfill: deployment ${deploymentId} no longer active, stopping.`
        )
        return
      }

      // If serviceUrls got populated by another path, stop
      if (hasAnyServiceUris(dep.serviceUrls)) {
        log.info(
          `Backfill: URIs already populated for ${deploymentId}, done.`
        )
        return
      }

      try {
        const services = await this.getServices(dseq, provider)
        consecutiveErrors = 0
        const hasUris = Object.values(services).some(s => s.uris?.length > 0)
        if (hasUris) {
          await this.prisma.akashDeployment.update({
            where: { id: deploymentId },
            data: { serviceUrls: services },
          })
          log.info(
            `Backfill: URIs populated for ${deploymentId} after ${(i + 1) * 10}s`
          )
          return
        }
      } catch (err) {
        consecutiveErrors++
        log.warn(
          `Backfill getServices attempt ${i + 1} failed for ${deploymentId}: ${err instanceof Error ? err.message : err}`
        )

        // If the provider consistently rejects us, the lease is likely dead
        if (consecutiveErrors >= 6) {
          log.error(
            `Backfill: ${consecutiveErrors} consecutive provider errors for ${deploymentId} — lease likely dead, marking CLOSED`
          )
          await this.prisma.akashDeployment.updateMany({
            where: { id: deploymentId, status: 'ACTIVE' },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          return
        }
      }
    }

    log.warn(
      `Backfill: gave up waiting for URIs on ${deploymentId} after 3 minutes`
    )
  }

  /**
   * Resume DEPLOYING deployments whose in-process POLL_URLS loop was lost
   * due to server restart (local dev without QStash). Re-enqueues the
   * POLL_URLS step so the readiness check continues.
   */
  async resumeDeployingDeployments(): Promise<void> {
    try {
      const deploying = await this.prisma.akashDeployment.findMany({
        where: {
          status: 'DEPLOYING',
          provider: { not: null },
          dseq: { gt: 0 },
        },
        select: { id: true, dseq: true, provider: true },
      })

      if (deploying.length === 0) return

      log.info(`Found ${deploying.length} DEPLOYING deployment(s) — resuming POLL_URLS`)

      const { handleAkashStep } = await import('../queue/webhookHandler.js')

      for (const dep of deploying) {
        handleAkashStep({
          step: 'POLL_URLS',
          deploymentId: dep.id,
          attempt: 1,
        }).catch(err =>
          log.error({ err, deploymentId: dep.id }, 'Failed to resume POLL_URLS')
        )
      }
    } catch (err) {
      log.error({ err }, 'resumeDeployingDeployments error')
    }
  }

  /**
   * Startup scan: find all ACTIVE Akash deployments with empty serviceUrls
   * and kick off backfills for them. Call this once at server startup so
   * interrupted backfills (e.g. from pod restarts) are resumed automatically.
   */
  async resumePendingBackfills(): Promise<void> {
    try {
      const activeDeployments = await this.prisma.akashDeployment.findMany({
        where: {
          status: 'ACTIVE',
        },
        select: { id: true, dseq: true, provider: true, serviceUrls: true },
      })
      const stale = activeDeployments.filter(
        dep => !hasAnyServiceUris(dep.serviceUrls)
      )

      if (stale.length === 0) {
        log.info(
          'No ACTIVE deployments with missing URIs.'
        )
        return
      }

      log.info(
        `Found ${stale.length} ACTIVE deployment(s) with missing URIs. Starting backfills...`
      )

      for (const dep of stale) {
        const dseq = Number(dep.dseq)
        if (!dep.provider) continue
        this.backfillServiceUrls(dep.id, dseq, dep.provider).catch(err =>
          log.error(
            { err },
            `Startup backfill failed for ${dep.id}`
          )
        )
      }
    } catch (err) {
      log.error({ err }, 'resumePendingBackfills error')
    }
  }

  /**
   * Close a deployment.
   *
   * Returns a structured result so callers can distinguish:
   *   * `CLOSED`         — chain accepted the close tx; the deployment
   *                        is gone on-chain. Local row should go to CLOSED.
   *   * `ALREADY_CLOSED` — chain rejected because the deployment is
   *                        already closed / not found. Treated as
   *                        idempotent success; local row should go to
   *                        CLOSED with no escrow drain remaining.
   *   * `FAILED`         — close attempt failed for environmental
   *                        reasons (RPC down, wallet out of gas,
   *                        account-sequence collision, etc.). The lease
   *                        may still be live on-chain and continue to
   *                        drain escrow until a retry succeeds. Local
   *                        row SHOULD go to CLOSE_FAILED so the stale-
   *                        deployment sweeper / ops will retry.
   *
   * Never throws — every chain or RPC error is captured in the returned
   * `FAILED` result. The previous void return collapsed every outcome
   * into "looks closed", masking stuck leases that kept billing.
   */
  async closeDeployment(dseq: number): Promise<CloseDeploymentResult> {
    try {
      const { txhash } = await runAkashTxAsync(
        ['tx', 'deployment', 'close', '--dseq', String(dseq)],
        { op: 'closeDeployment', meta: { dseq } },
      )
      log.info({ dseq, txhash }, 'Deployment close TX accepted')
      return { chainStatus: 'CLOSED', txhash }
    } catch (err) {
      const error = err as Error
      const message = error.message ?? String(err)
      if (CLOSE_ALREADY_GONE_PATTERNS.test(message)) {
        log.info(
          { dseq, message: message.slice(0, 200) },
          'closeDeployment: chain reports deployment already gone — treating as idempotent success',
        )
        return { chainStatus: 'ALREADY_CLOSED', reason: message.slice(0, 200) }
      }
      log.error(
        { dseq, error: message.slice(0, 300) },
        'closeDeployment: chain close failed — leaving lease open, caller MUST mark CLOSE_FAILED',
      )
      return { chainStatus: 'FAILED', error: message.slice(0, 300) }
    }
  }

  /**
   * Get deployment logs via async CLI spawn (non-blocking).
   * Falls back to mTLS REST if the CLI binary is unavailable.
   */
  async getLogs(
    dseq: number,
    provider: string,
    service?: string,
    tail?: number,
    _gseq = 1,
    _oseq = 1
  ): Promise<string> {
    const args = ['lease-logs', '--dseq', String(dseq), '--provider', provider]
    if (service) args.push('--service', service)
    if (tail) args.push('--tail', String(tail))

    try {
      return await runProviderServicesAsync(args, 45_000)
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 300) ?? 'unknown error'
      log.warn(`getLogs failed for dseq=${dseq}: ${msg}`)
      throw new Error(`Failed to fetch logs for dseq=${dseq}: ${msg}`)
    }
  }

  /**
   * Spawn `provider-services lease-logs --follow` as a long-lived child
   * process and expose the stdout as a line-oriented stream. Used by the SSE
   * log-streaming endpoint. Caller MUST invoke `close()` on disconnect.
   *
   * The child process is the source of truth — when it exits we emit
   * `onClose`. We do not auto-restart: a restarted process would re-emit the
   * existing tail, double-printing lines clients already saw.
   */
  streamLogs(
    dseq: number,
    provider: string,
    service?: string,
    tail = 50,
  ): LogStream {
    const args = [
      'lease-logs',
      '--dseq', String(dseq),
      '--provider', provider,
      '--follow',
    ]
    if (service) args.push('--service', service)
    if (tail > 0) args.push('--tail', String(tail))

    const env = getAkashEnv()
    log.info(`Spawning log stream: provider-services ${args.join(' ')}`)
    return spawnLogStream('provider-services', args, env)
  }

  /**
   * Spawn an interactive shell session via `provider-services lease-shell`.
   * Uses node-pty to allocate a pseudo-terminal so `--tty` works
   * (provider-services requires its stdin to be a real TTY).
   */
  async getShell(
    dseq: number,
    provider: string,
    service: string,
    command?: string
  ): Promise<ShellSession> {
    const env = getAkashEnv()

    // Default shell selection — minimal images (alpine, scratch-derived,
    // distroless-shell) often DO NOT have /bin/bash. Hard-defaulting to
    // /bin/bash makes `af ssh` fail on those images even though the
    // container is alive and the platform exec path works fine. We pick
    // bash if it exists, fall back to sh, and run interactively in both
    // cases. Caller-provided `command` is passed through unchanged so
    // explicit `--command /bin/bash` / `--command /bin/zsh` / etc still
    // work the way the user typed it.
    const shellPositional = command
      ? [command]
      : [
          '/bin/sh',
          '-c',
          'if command -v bash >/dev/null 2>&1; then exec bash -il; else exec sh -i; fi',
        ]

    const args = [
      'lease-shell',
      service,
      ...shellPositional,
      '--dseq', String(dseq),
      '--provider', provider,
      '--stdin',
      '--tty',
    ]

    log.info(`Spawning shell: provider-services ${args.join(' ')}`)

    // node-pty is optional — fall back to spawn without --tty if unavailable
    let pty: any
    try {
      const { createRequire } = await import('module')
      const require = createRequire(import.meta.url)
      pty = require('node-pty')
    } catch {
      log.warn('node-pty not available, falling back to spawn without --tty')
      return this.getShellFallback(env, args.filter(a => a !== '--tty'))
    }

    // Resolve full path — node-pty's posix_spawnp may not search PATH correctly
    let binPath = 'provider-services'
    try {
      binPath = execFileSync('which', ['provider-services'], { encoding: 'utf-8' }).trim()
    } catch { /* fall through with bare name */ }

    const ptyProcess = pty.spawn(binPath, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env,
    })

    let killed = false

    const session: ShellSession = {
      write(data: Buffer | string) {
        if (!killed) {
          ptyProcess.write(typeof data === 'string' ? data : data.toString())
        }
      },
      onData(callback: (data: Buffer) => void) {
        ptyProcess.onData((data: string) => {
          callback(Buffer.from(data))
        })
      },
      onExit(callback: (code: number | null) => void) {
        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          killed = true
          callback(exitCode)
        })
      },
      resize(cols: number, rows: number) {
        if (!killed) {
          ptyProcess.resize(cols, rows)
        }
      },
      kill() {
        if (!killed) {
          killed = true
          ptyProcess.kill()
        }
      },
    }

    return session
  }

  private getShellFallback(env: Record<string, string>, args: string[]): ShellSession {
    const child = spawn('provider-services', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let killed = false

    return {
      write(data: Buffer | string) {
        if (!killed && child.stdin.writable) {
          child.stdin.write(data)
        }
      },
      onData(callback: (data: Buffer) => void) {
        child.stdout.on('data', callback)
        child.stderr.on('data', callback)
      },
      onExit(callback: (code: number | null) => void) {
        child.on('close', (code) => {
          killed = true
          callback(code)
        })
      },
      kill() {
        if (!killed) {
          killed = true
          child.kill('SIGTERM')
        }
      },
    }
  }

  // ========================================
  // High-level deployment operations
  // ========================================

  /**
   * Deploy any service to Akash (full flow).
   *
   * When QStash is available (production), this method creates the DB record
   * and enqueues the first step, returning immediately. The deployment then
   * proceeds through the step pipeline in the background with automatic
   * retry (up to 3 times) on failure.
   *
   * When QStash is not available (local dev), the steps execute in-process
   * sequentially via the same step handlers, preserving the same code path.
   */
  async deployService(
    serviceId: string,
    options: {
      deposit?: number
      sdlContent?: string
      skipEnvInjection?: boolean
      resourceOverrides?: {
        cpu?: number
        memory?: string
        storage?: string
        gpu?: { units: number; vendor: string; model?: string } | null
      }
      baseImage?: string
    } = {}
  ): Promise<string> {
    const deposit = options.deposit || DEFAULT_DEPOSIT_UACT

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        site: true,
        afFunction: true,
      },
    })

    if (!service) {
      throw new Error(`Service not found: ${serviceId}`)
    }

    // Close any existing ACTIVE deployments for this service
    const existingDeployments = await this.prisma.akashDeployment.findMany({
      where: {
        serviceId: service.id,
        status: 'ACTIVE',
      },
    })

    const { isQStashEnabled, publishJob } =
      await import('../queue/qstashClient.js')

    if (existingDeployments.length > 0) {
      log.info(
        `Closing ${existingDeployments.length} existing deployment(s) for service ${service.name}...`
      )

      for (const existing of existingDeployments) {
        try {
          const existingDseq = Number(existing.dseq)
          log.info(`Closing previous deployment dseq=${existingDseq} on-chain...`)
          await this.closeDeployment(existingDseq)

          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          log.info(
            `Closed deployment dseq=${existingDseq}`
          )
        } catch (err: any) {
          log.warn(
            `Failed to close deployment dseq=${existing.dseq}: ${err.message} — keeping as ACTIVE, may need manual close`
          )
        }
      }
    }

    // Prepare SDL content
    let sdlContent =
      options.sdlContent || (await this.generateSDLForService(service, options.resourceOverrides, options.baseImage))
    if (!options.skipEnvInjection) {
      sdlContent = await this.injectPersistedEnvVars(
        service.id,
        service.projectId,
        sdlContent
      )
    }

    // Create DB record with CREATING status.
    // Use negative timestamp as temporary dseq — the real dseq is assigned in SUBMIT_TX.
    // This avoids the @@unique([owner, dseq]) constraint since real dseqs are always positive.
    const owner = await this.getAccountAddress()
    const tempDseq = BigInt(-Date.now())
    const deployment = await this.prisma.akashDeployment.create({
      data: {
        owner,
        dseq: tempDseq,
        sdlContent,
        serviceId: service.id,
        afFunctionId:
          service.type === 'FUNCTION' ? service.afFunction?.id : null,
        siteId: service.type === 'SITE' ? service.site?.id : null,
        depositUakt: BigInt(deposit),
        status: 'CREATING',
        retryCount: 0,
      },
    })

    log.info(
      `Created deployment record ${deployment.id}, enqueuing SUBMIT_TX step...`
    )

    // Enqueue the first step — QStash or in-process depending on environment
    const { handleAkashStep } = await import('../queue/webhookHandler.js')

    if (isQStashEnabled()) {
      await publishJob('/queue/akash/step', {
        step: 'SUBMIT_TX',
        deploymentId: deployment.id,
      })
    } else {
      // Local dev: run step pipeline in-process (non-blocking — fire and forget)
      handleAkashStep({ step: 'SUBMIT_TX', deploymentId: deployment.id }).catch(
        err => {
          log.error(
            { err },
            'In-process step pipeline failed'
          )
        }
      )
    }

    return deployment.id
  }

  /**
   * Deploy a function to Akash (convenience method)
   */
  async deployFunction(
    functionId: string,
    sourceCode: string,
    functionName: string,
    deposit = DEFAULT_DEPOSIT_UACT
  ): Promise<string> {
    const func = await this.prisma.aFFunction.findUnique({
      where: { id: functionId },
      select: { serviceId: true },
    })

    if (!func?.serviceId) {
      throw new Error('Function has no associated service in the registry')
    }

    return this.deployService(func.serviceId, { deposit })
  }

  /**
   * Generate SDL based on service type.
   */
  private async generateSDLForService(service: {
    id: string
    type: ServiceType
    name: string
    slug: string
    templateId?: string | null
    containerPort?: number | null
    dockerImage?: string | null
    // Phase 38 — persistent volumes for raw Docker images. Json column on
    // Service. Templates own their own volumes via template.persistentStorage.
    volumes?: unknown
    // Phase 39 / GitHub-source flavor — used to pick a sensible default port
    // when the user (or builder) didn't set one. See port-fallback below.
    flavor?: string | null
    gitProvider?: string | null
    site?: { id: string } | null
    afFunction?: { id: string; sourceCode: string | null } | null
  }, resourceOverrides?: {
    cpu?: number
    memory?: string
    storage?: string
    gpu?: { units: number; vendor: string; model?: string } | null
  }, baseImage?: string): Promise<string> {
    if (service.type === 'FUNCTION') {
      if (!service.afFunction?.sourceCode) {
        throw new Error('Function has no source code')
      }
      return this.generateFunctionSDL(
        service.slug,
        service.afFunction.sourceCode
      )
    }

    const { getTemplateById, generateSDLFromTemplate } =
      await import('../../templates/index.js')

    // Priority 1: Use the service's own templateId (set when deployed from a template).
    // This ensures redeployments use the same template config (ports, env, resources)
    // that was used for the initial deployment.
    if (service.templateId) {
      const template = getTemplateById(service.templateId)
      if (template) {
        // Composite templates (with components) produce multi-service SDLs that
        // cannot be regenerated from generateSDLFromTemplate (which is single-service).
        // Reuse the SDL from the most recent deployment for this service instead.
        if (template.components?.length) {
          const lastDeployment = await this.prisma.akashDeployment.findFirst({
            where: {
              serviceId: service.id,
              sdlContent: { not: '' },
            },
            orderBy: { createdAt: 'desc' },
            select: { sdlContent: true, savedSdl: true },
          })
          const previousSdl = lastDeployment?.savedSdl ?? lastDeployment?.sdlContent
          if (previousSdl) {
            log.info(
              `Reusing composite SDL from previous deployment for service '${service.slug}' (template '${service.templateId}')`
            )
            return previousSdl
          }
          log.warn(
            `Composite template '${service.templateId}' but no previous SDL found for service '${service.slug}'. Cannot regenerate composite SDL from sidebar deploy — use the template deploy flow instead.`
          )
          throw new Error(
            `This service was deployed from the composite template '${template.name}'. Please redeploy from the template catalog to include all components (database, assets, etc).`
          )
        }

        log.info(
          { templateId: service.templateId, hasResourceOverrides: !!resourceOverrides },
          `Generating SDL from template '${service.templateId}' for service '${service.slug}'`
        )
        // SDL ceiling for GPU deploys is unconditional (see
        // `templates/sdl.ts:GPU_SDL_PRICING_CEILING_UACT`). No
        // dynamic-pricing lookup needed — providers bid, the bid-
        // selection layer picks the cheapest preferred bid.
        return generateSDLFromTemplate(template, {
          serviceName: service.slug,
          resourceOverrides: resourceOverrides
            ? {
                cpu: resourceOverrides.cpu,
                memory: resourceOverrides.memory,
                storage: resourceOverrides.storage,
                gpu: resourceOverrides.gpu === null
                  ? null
                  : resourceOverrides.gpu
                    ? { units: resourceOverrides.gpu.units, vendor: resourceOverrides.gpu.vendor as TemplateGpu['vendor'], model: resourceOverrides.gpu.model }
                    : undefined,
              }
            : undefined,
        })
      }
      log.warn(
        `Service '${service.slug}' has templateId '${service.templateId}' but template not found. Falling back.`
      )
    }

    // Priority 2: Custom Docker image or user-selected base image
    const effectiveImage = service.dockerImage || baseImage
    if (effectiveImage) {
      // Default-port heuristic: GitHub-source builds (Next/Nuxt/Bun/etc.)
      // overwhelmingly listen on 3000, so falling back to 80 there is the
      // single biggest source of "deploy succeeds but URL 404s" reports.
      // For docker / server flavors the user explicitly picked the image,
      // so 80 stays the right default (nginx, caddy, traefik all listen
      // there). Builder writes the detected port back to Service.containerPort
      // when nixpacks reports it, so this fallback only kicks in for the
      // (common) case where neither builder nor user supplied one.
      const isGithubBuild = service.flavor === 'github' || !!service.gitProvider
      const fallbackPort = isGithubBuild ? 3000 : 80
      const port = service.containerPort || fallbackPort
      if (!service.containerPort) {
        log.warn(
          { serviceId: service.id, slug: service.slug, isGithubBuild, fallbackPort },
          `Service '${service.slug}' has no containerPort — defaulting SDL port to ${fallbackPort}. Set it explicitly via Config → Container port if your app listens elsewhere.`
        )
      }
      const parsedVolumes = parseServiceVolumes(service.volumes)
      log.info(
        { volumes: parsedVolumes.length },
        `Generating SDL for Docker image '${effectiveImage}' (port ${port}) for service '${service.slug}'`
      )
      return this.generateCustomDockerSDL(
        service.slug,
        effectiveImage,
        port,
        resourceOverrides,
        parsedVolumes,
      )
    }

    // Priority 3: Default type-to-template mapping (for services created without a template)
    const typeToTemplate: Record<string, string> = {
      SITE: 'nginx-site',
      VM: 'node-ws-gameserver',
      DATABASE: 'postgres',
    }

    const fallbackTemplateId = typeToTemplate[service.type]
    if (fallbackTemplateId) {
      const template = getTemplateById(fallbackTemplateId)
      if (template) {
        return generateSDLFromTemplate(template, { serviceName: service.slug })
      }
    }

    // Priority 4: Hardcoded fallback SDLs
    switch (service.type) {
      case 'SITE':
        return this.generateSiteSDL(service.slug)
      case 'VM':
        return this.generateVMSDL(service.slug)
      case 'DATABASE':
        return this.generateDatabaseSDL(service.slug)
      default:
        throw new Error(
          `SDL generation not supported for service type: ${service.type}`
        )
    }
  }

  /**
   * Fetch persisted env vars for a service, resolve `{{services.*}}`
   * interpolations using sibling services, then inject them into the SDL.
   * If the SDL already has env vars, the persisted ones are merged (persisted wins).
   */
  private async injectPersistedEnvVars(
    serviceId: string,
    projectId: string,
    sdlContent: string
  ): Promise<string> {
    const { buildServiceMap, resolveEnvVars } =
      await import('../../utils/envInterpolation.js')

    const persistedVars = await this.prisma.serviceEnvVar.findMany({
      where: { serviceId },
    })
    if (persistedVars.length === 0) return sdlContent

    // Fetch sibling services for interpolation
    const siblings = await this.prisma.service.findMany({
      where: { projectId },
      include: {
        envVars: true,
        ports: true,
      },
    })
    const serviceMap = buildServiceMap(
      siblings.map((s: any) => ({
        slug: s.slug,
        internalHostname: s.internalHostname,
        envVars: s.envVars.map((e: any) => ({ key: e.key, value: e.value })),
        ports: s.ports.map((p: any) => ({
          containerPort: p.containerPort,
          publicPort: p.publicPort,
        })),
      }))
    )

    const resolved = resolveEnvVars(
      persistedVars.map((v: any) => ({ key: v.key, value: v.value })),
      serviceMap
    )

    // Merge into SDL: find the `env:` block or inject one
    const envLines = resolved
      .map(({ key, value }) => `      - ${key}=${value}`)
      .join('\n')

    // If the SDL already has an env block, append to it
    const envBlockRegex = /(    env:\n)((?:      - .+\n)*)/
    if (envBlockRegex.test(sdlContent)) {
      return sdlContent.replace(
        envBlockRegex,
        (match, header, existingLines) => {
          // Parse existing keys to avoid duplicates (persisted wins)
          const existingKeys = new Set(
            existingLines
              .split('\n')
              .filter((l: string) => l.trim().startsWith('- '))
              .map((l: string) => l.trim().replace(/^- /, '').split('=')[0])
          )
          const newLines = resolved
            .filter(({ key }) => !existingKeys.has(key))
            .map(({ key, value }) => `      - ${key}=${value}\n`)
            .join('')
          // Override existing keys with persisted values
          let updatedExisting = existingLines
          for (const { key, value } of resolved) {
            if (existingKeys.has(key)) {
              const keyRegex = new RegExp(`(      - ${key})=.*\n`)
              updatedExisting = updatedExisting.replace(
                keyRegex,
                `$1=${value}\n`
              )
            }
          }
          return header + updatedExisting + newLines
        }
      )
    }

    // No env block — inject before `expose:`
    const exposeIdx = sdlContent.indexOf('    expose:')
    if (exposeIdx !== -1) {
      return (
        sdlContent.slice(0, exposeIdx) +
        `    env:\n${envLines}\n` +
        sdlContent.slice(exposeIdx)
      )
    }

    return sdlContent
  }

  /**
   * Generate SDL for a custom Docker image with a specific container port.
   */
  private generateCustomDockerSDL(
    name: string,
    image: string,
    containerPort: number,
    resourceOverrides?: {
      cpu?: number
      memory?: string
      storage?: string
      gpu?: { units: number; vendor: string; model?: string } | null
    },
    volumes: ServiceVolume[] = [],
  ): string {
    const needsKeepAlive = /^(ubuntu|debian|alpine|centos|fedora|busybox|amazonlinux|rockylinux|almalinux)(:|$)/i.test(image)

    const argsBlock = needsKeepAlive
      ? `    args:
      - sh
      - -c
      - "echo 'Container ready on port ${containerPort}'; tail -f /dev/null"
`
      : ''

    // ── Registry auth ───────────────────────────────────────────────
    // GitHub-source builds push to GHCR as private packages (team-plan
    // orgs can't flip container visibility via REST API; this was the
    // previous unblocker and it's fragile as fuck). Akash SDL supports
    // per-service `credentials:` which the provider uses as an
    // imagePullSecret when scheduling the pod — private images pull
    // fine and we never touch GitHub package visibility.
    //
    // The token ends up in the manifest that is sent to the *winning
    // provider only* (not on-chain), so scope it minimally. We
    // explicitly require a read-only PAT (GHCR_PULL_TOKEN); falling
    // back to GHCR_PUSH_TOKEN works but leaks write access — log loud.
    const credentialsBlock = buildGhcrCredentialsBlock(image)

    const cpu = resourceOverrides?.cpu ?? 0.5
    const memory = resourceOverrides?.memory ?? '512Mi'
    const ephemeralStorage = resourceOverrides?.storage ?? '1Gi'
    const gpu = resourceOverrides?.gpu

    let gpuBlock = ''
    if (gpu && gpu.units > 0) {
      const hasSpecificModel = gpu.model && gpu.model !== '*'
      const modelLine = hasSpecificModel
        ? `
                - model: ${gpu.model}`
        : ''
      gpuBlock = `
        gpu:
          units: ${gpu.units}
          attributes:
            vendor:
              ${gpu.vendor}:${modelLine}`
    }

    // Phase 38 — emit `params.storage.<name>` mounts and named storage entries
    // matching the template generator (templates/sdl.ts:buildStorageProfileBlock).
    // Akash requires named storage entries to declare `persistent: true` and
    // `class: beta3` so the provider picks a backing volume that survives pod
    // restarts.
    const paramsBlock = volumes.length > 0
      ? `    params:
      storage:
${volumes.map(v => `        ${v.name}:\n          mount: ${v.mountPath}\n          readOnly: false`).join('\n')}
`
      : ''

    const ephemeralLine = `          - size: ${ephemeralStorage}`
    const namedStorageLines = volumes
      .map(v => `          - name: ${v.name}\n            size: ${v.size}\n            attributes:\n              persistent: true\n              class: beta3`)
      .join('\n')
    const storageBlock = volumes.length > 0
      ? `${ephemeralLine}\n${namedStorageLines}`
      : `          - size: ${ephemeralStorage}`

    // When using named (non-ephemeral) storage, the resources block uses an
    // ARRAY syntax (one entry per storage). When only the default ephemeral
    // exists, Akash also accepts the legacy `storage: { size: "1Gi" }` shape.
    // Use the array form unconditionally — both work and the array keeps the
    // builder branch-free.
    const storageProfile = `        storage:\n${storageBlock}`

    return `---
version: "2.0"

services:
  ${name}:
    image: ${image}
${credentialsBlock}${argsBlock}    expose:
      - port: ${containerPort}
        as: 80
        to:
          - global: true
${paramsBlock}
profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: ${cpu}
        memory:
          size: ${memory}
${storageProfile}${gpuBlock}

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        ${name}:
          denom: uact
          amount: ${resolveSdlPricingUact(!!(gpu && gpu.units > 0))}

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  /**
   * Generate SDL for a Bun/Hono function
   */
  private generateFunctionSDL(name: string, sourceCode: string): string {
    const base64Code = Buffer.from(sourceCode, 'utf-8').toString('base64')

    const imports = sourceCode.match(/from ['"]([^'"./][^'"]*)['"]/g) || []
    const packages = [
      ...new Set(
        imports
          .map(i => {
            const match = i.match(/from ['"]([^'"./][^'"]*)['"]/)?.[1]
            return (
              match
                ?.split('/')
                .slice(0, match.startsWith('@') ? 2 : 1)
                .join('/') || ''
            )
          })
          .filter(Boolean)
      ),
    ]

    const installCmd =
      packages.length > 0
        ? `bun add ${packages.join(' ')}`
        : 'echo "No dependencies to install"'

    const script = [
      'set -e',
      "echo 'Deploying function...'",
      'mkdir -p /app',
      'cd /app',
      'bun init -y',
      `echo '${base64Code}' | base64 -d > /app/index.ts`,
      `echo 'Installing dependencies: ${packages.join(', ') || 'none'}'`,
      `${installCmd} || { echo 'ERROR: bun add failed'; exit 1; }`,
      "echo 'Starting function on port 3000...'",
      'exec bun run index.ts',
    ].join(' && ')

    return `---
version: "2.0"

services:
  ${name}:
    image: oven/bun:1.1-alpine
    env:
      - PORT=3000
    args:
      - sh
      - -c
      - "${script}"
    expose:
      - port: 3000
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 1000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  private generateSiteSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: nginx:alpine
    env:
      - NGINX_PORT=80
    expose:
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.25
        memory:
          size: 256Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  // Fixed by audit 2026-03: generate random password per deployment (was hardcoded 'akash')
  private generateVMSDL(name: string): string {
    const password = randomBytes(16).toString('hex')
    return `---
version: "2.0"

services:
  ${name}:
    image: ubuntu:22.04
    args:
      - sh
      - -c
      - |
        apt-get update && apt-get install -y openssh-server
        mkdir /run/sshd
        echo 'root:${password}' | chpasswd
        sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
        /usr/sbin/sshd -D
    expose:
      - port: 22
        as: 22
        to:
          - global: true
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 2000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  // Fixed by audit 2026-03: generate random password per deployment (was hardcoded 'akash_secure_password')
  private generateDatabaseSDL(name: string): string {
    const dbPassword = randomBytes(20).toString('hex')
    return `---
version: "2.0"

services:
  ${name}:
    image: postgres:15-alpine
    env:
      - POSTGRES_DB=akashdb
      - POSTGRES_USER=akash
      - POSTGRES_PASSWORD=${dbPassword}
    expose:
      - port: 5432
        as: 5432
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 1500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }
}

// Singleton instance
let orchestratorInstance: AkashOrchestrator | null = null

export function getAkashOrchestrator(prisma: PrismaClient): AkashOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AkashOrchestrator(prisma)
  }
  return orchestratorInstance
}
