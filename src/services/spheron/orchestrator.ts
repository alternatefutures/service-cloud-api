/**
 * Spheron orchestrator.
 *
 * High-level deploy / status / close / shell / logs / health for the Spheron
 * provider. Wraps `SpheronClient` (typed REST), `cloudInit.ts` (transformation),
 * and `node-pty` / `execFile` (SSH-based shell + logs).
 *
 * Mirrors the structure of `services/phala/orchestrator.ts` — the closest
 * analogue. Differences vs Phala:
 *
 *   - **No native shell/log API.** Spheron only gives us a VM with SSH on
 *     port 22 (or whatever `sshPort` it returns). All shell/log/exec is done
 *     by SSH'ing to that VM with the platform-managed key in
 *     `SPHERON_SSH_KEY_PATH`. This is fundamentally different from Phala's
 *     `npx phala cvms attach` flow.
 *   - **No stop/start.** Spheron only supports deploy + DELETE. Resume after
 *     low-balance pause = re-deploy from saved cloud-init (mirror Akash's
 *     `savedSdl` pattern with `savedCloudInit` + `savedDeployInput`).
 *   - **Existence probe (Phase 49b pattern).** A dedicated
 *     `probeDeploymentExistence` distinguishes "VM genuinely gone at provider"
 *     from "API threw transiently" so the sweeper never closes on a blip.
 *
 * Lifecycle-safety contracts honored here (Phase 31 / 34 / 49 / 49b):
 *
 *   - `getDeploymentStatus()` returns null on transient errors. The provider
 *     adapter then maps null → `OverallHealth: 'unknown'`. NEVER returns a
 *     fake "running" snapshot on catch.
 *   - `closeDeployment()` is idempotent: 404 / "already gone" patterns are
 *     swallowed and treated as success. The DB-side bookkeeping (and the
 *     provider adapter's billing settlement) happens regardless.
 *   - `probeDeploymentExistence()` returns 'gone' ONLY on a confirmed 404
 *     or a definitively-terminal Spheron status. 'exists' on any 200.
 *     'unknown' on every other error.
 *
 * Singleton pattern via `getSpheronOrchestrator(prisma)` mirrors
 * `getPhalaOrchestrator`.
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'

import * as pty from 'node-pty'
import type { PrismaClient } from '@prisma/client'

import { createLogger } from '../../lib/logger.js'
import type {
  ShellOptions,
  ShellSession,
  LogOptions,
  LogStream,
  LogStreamOptions,
} from '../providers/types.js'
import {
  SpheronApiError,
  getSpheronClient,
  type SpheronClient,
  type SpheronCreateDeploymentInput,
  type SpheronDeploymentObject,
} from './client.js'

const execFileAsync = promisify(execFile)
const log = createLogger('spheron-orchestrator')

// ─── SSH connection options ──────────────────────────────────────────

interface SshConnectionInfo {
  ipAddress: string
  sshUser: string
  sshPort: number
}

const SSH_BASE_OPTIONS = [
  '-o', 'StrictHostKeyChecking=accept-new',
  // We never persist host keys: the next deploy on the same provider may
  // reuse the same IP with a different host key (provider re-imaging) and we
  // don't want a "Host key verification failed" the second time around.
  // Trade-off: minor MITM exposure on first connect, mitigated by the fact
  // that the key was already shipped to that VM via Spheron's API and any
  // attacker would need to compromise Spheron itself.
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR',
  // Keep idle SSH sessions cheap — server-side ServerAliveInterval is the
  // only thing keeping the pipe open under our control.
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  // Cap connection setup so a black-holed VM fails fast (we surface the
  // result to the caller rather than blocking a queue worker for 2 min).
  '-o', 'ConnectTimeout=15',
]

/**
 * Resolve `SPHERON_SSH_KEY_PATH` honoring leading `~/`. We don't fail loudly
 * here — orchestrator methods that need the key check existsSync individually
 * so a missing key prevents the relevant operation but doesn't crash startup.
 */
export function getSpheronSshKeyPath(): string {
  const raw = process.env.SPHERON_SSH_KEY_PATH || '~/.ssh/af_spheron_ed25519'
  if (raw.startsWith('~/')) {
    return resolvePath(homedir(), raw.slice(2))
  }
  return resolvePath(raw)
}

function assertSshKeyExists(): string {
  const path = getSpheronSshKeyPath()
  if (!existsSync(path)) {
    throw new Error(
      `SPHERON_SSH_KEY_PATH does not exist: ${path}. ` +
        `Generate one with: ssh-keygen -t ed25519 -f ${path} -C af-platform-spheron -N ""`,
    )
  }
  return path
}

// ─── Types for high-level deploy input ───────────────────────────────

export interface DeployServiceSpheronOptions {
  /** Pre-picked Spheron offer info (caller resolves via `pickOffer` / GraphQL). */
  provider: string
  offerId: string
  gpuType: string
  gpuCount: number
  region: string
  operatingSystem: string
  instanceType: 'SPOT' | 'DEDICATED' | 'CLUSTER'
  /** Pricing snapshot persisted on the row for audit. */
  hourlyRateCents: number
  originalHourlyRateCents: number
  marginRate: number
  pricedSnapshotJson: unknown

  /** Pre-registered SSH key id (from spheronSshKeyBootstrap). */
  sshKeyId: string

  /** Compose / env injected into the cloudInit. */
  composeContent?: string
  envVars?: Record<string, string>

  /**
   * TCP container ports to open through the VM's firewall (UFW) so the
   * subdomain proxy can reach them at `http://<ipAddress>:<port>`.
   * See `cloudInit.ts:BuildCloudInitInput.exposePorts` for the full
   * architecture decision and the `|| true` rationale.
   */
  exposePorts?: number[]

  /** Org/billing. Mirrors PhalaDeployment.orgBillingId etc. */
  orgBillingId: string
  organizationId: string

  /** Optional name override (defaults to af-<service.slug>-<timestamp>). */
  name?: string

  /** Optional policy back-reference. */
  policyId?: string

  /** Used by `handlePhalaFailure`-style retry path. */
  parentDeploymentId?: string
  retryCount?: number
}

export interface DockerHealthSnapshot {
  containers: Array<{ name: string; state: string; status: string }>
  /** True when at least one container is up AND none are crash-looping. */
  allRunning: boolean
  /** Filled when SSH connected but `docker ps` failed or returned empty. */
  warning?: string
}

// ─── Synchronous-POST rejection error ────────────────────────────────

/**
 * Phase 50.1 (2026-05-15) — typed error thrown by
 * `deployServiceSpheron` when the synchronous first POST to Spheron is
 * rejected upstream.
 *
 * Carries the diagnostic context the resolver needs to map the failure
 * to a `GraphQLError` with `extensions.code: 'NO_CAPACITY'` (so the web-
 * app auto-router can fall back to Akash). The orchestrator has already
 * marked the DB row FAILED (and blocklisted the SKU when applicable)
 * before throwing — the resolver does NOT need to clean up.
 *
 * `isStockShortage` distinguishes the most common case (Spheron 400
 * "Not Enough Stock") from generic POST failures (5xx, auth, validation
 * unrelated to inventory). Resolvers should currently treat ALL
 * `SpheronCreateRejectedError`s as `NO_CAPACITY` for the auto-router —
 * an Akash fallback is always preferable to a generic GraphQL error for
 * the Standard-mode flow.
 */
export class SpheronCreateRejectedError extends Error {
  readonly deploymentId: string
  readonly gpuType?: string
  readonly isStockShortage: boolean
  readonly upstreamError?: Error

  constructor(
    message: string,
    ctx: {
      deploymentId: string
      gpuType?: string
      isStockShortage: boolean
      upstreamError?: Error
    },
  ) {
    super(message)
    this.name = 'SpheronCreateRejectedError'
    this.deploymentId = ctx.deploymentId
    this.gpuType = ctx.gpuType
    this.isStockShortage = ctx.isStockShortage
    this.upstreamError = ctx.upstreamError
  }
}

// ─── Orchestrator class ──────────────────────────────────────────────

export class SpheronOrchestrator {
  constructor(private prisma: PrismaClient) {}

  private requireClient(): SpheronClient {
    const client = getSpheronClient()
    if (!client) {
      throw new Error('Spheron is not configured (SPHERON_API_KEY missing)')
    }
    return client
  }

  // ── Deploy ──────────────────────────────────────────────────

  /**
   * Create the SpheronDeployment DB row, build cloudInit, POST to Spheron,
   * persist `providerDeploymentId`, return our internal deployment id.
   *
   * Phase 34 contract: the chain-side / API-side side effect MUST round-trip
   * into our local DB before this method returns. We persist the row first,
   * then call the API, then persist the upstream id. A crash between the API
   * call and the second persist leaves a row in CREATING with no
   * providerDeploymentId — the stale-deployment sweeper picks that up at the
   * 25-min threshold and marks it FAILED + opsAlerts.
   *
   * This method does NOT poll for `running` — that's a separate QStash step
   * (`POLL_STATUS`). We return as soon as the API accepts the deploy.
   */
  async deployServiceSpheron(
    serviceId: string,
    opts: DeployServiceSpheronOptions,
  ): Promise<string> {
    const { buildCloudInit } = await import('./cloudInit.js')

    const service = await this.prisma.service.findUnique({ where: { id: serviceId } })
    if (!service) throw new Error(`Service not found: ${serviceId}`)

    const name =
      opts.name ?? `af-${service.slug}-${Date.now().toString(36)}`

    const cloudInit = buildCloudInit({
      composeContent: opts.composeContent,
      envVars: opts.envVars,
      operatingSystem: opts.operatingSystem,
      exposePorts: opts.exposePorts,
    })

    // Build the upstream payload up-front so we can persist it as
    // savedDeployInput before any network call. If the POST fails, we keep
    // the recipe for the retry path.
    const upstreamInput: SpheronCreateDeploymentInput = {
      provider: opts.provider,
      offerId: opts.offerId,
      gpuType: opts.gpuType,
      gpuCount: opts.gpuCount,
      region: opts.region,
      operatingSystem: opts.operatingSystem,
      instanceType: opts.instanceType,
      sshKeyId: opts.sshKeyId,
      name,
      cloudInit: Object.keys(cloudInit).length > 0 ? cloudInit : undefined,
    }

    // Step 1 — DB row in CREATING with the recipe persisted.
    const row = await this.prisma.spheronDeployment.create({
      data: {
        name,
        status: 'CREATING',
        provider: opts.provider,
        offerId: opts.offerId,
        gpuType: opts.gpuType,
        gpuCount: opts.gpuCount,
        region: opts.region,
        operatingSystem: opts.operatingSystem,
        instanceType: opts.instanceType,
        sshKeyId: opts.sshKeyId,
        savedCloudInit: cloudInit as object,
        savedDeployInput: upstreamInput as unknown as object,
        composeContent: opts.composeContent ?? null,
        envKeys: opts.envVars ? Object.keys(opts.envVars) : undefined,
        pricedSnapshotJson: opts.pricedSnapshotJson as object,
        hourlyRateCents: opts.hourlyRateCents,
        originalHourlyRateCents: opts.originalHourlyRateCents,
        marginRate: opts.marginRate,
        orgBillingId: opts.orgBillingId,
        organizationId: opts.organizationId,
        retryCount: opts.retryCount ?? 0,
        parentDeploymentId: opts.parentDeploymentId,
        policyId: opts.policyId,
        serviceId,
      },
    })

    // Step 2 — POST. The QStash step layer wraps this; the orchestrator
    // surface throws on failure so the step's try/catch can route to
    // HANDLE_FAILURE.
    const client = this.requireClient()
    let created
    try {
      created = await client.createDeployment(upstreamInput)
    } catch (err) {
      // Synchronous first-POST failure (e.g. Spheron 400 "Not Enough Stock",
      // 401, 5xx not retryable, network timeout).
      //
      // Phase 50.1 fix (2026-05-15): the previous behaviour left the
      // CREATING row in the DB and re-threw, so:
      //   1. The web-app received a generic GraphQLError with NO
      //      `extensions.code` — the auto-router couldn't recognise the
      //      failure and didn't fall back to Akash.
      //   2. The CREATING row stayed orphan in the DB, and the next
      //      `resumeStuckDeployments` (on cloud-api restart) re-POSTed
      //      it — hammering Spheron with already-known-bad requests.
      //
      // Now we:
      //   (a) Persist the upstream message to the row so it's observable.
      //   (b) Mark the row FAILED so resumeStuckDeployments skips it.
      //   (c) Blocklist the SKU on stock errors so the dropdown + picker
      //       hide it for ~15 min (see stockBlocklist.ts).
      //   (d) Throw a typed `SpheronCreateRejectedError` carrying the
      //       upstream details so the resolver can map it to
      //       `extensions.code: 'NO_CAPACITY'` and the auto-router falls
      //       back to Akash.
      //
      // We import dynamically to avoid a top-of-file cycle between the
      // orchestrator and its dependents (the blocklist is also imported
      // by the picker, which is sometimes imported by this file).
      const { matchesStockShortage, markStockExhausted } = await import('./stockBlocklist.js')
      const { SpheronApiError } = await import('./client.js')

      let detailedMessage = err instanceof Error ? err.message : 'Spheron POST failed'
      if (err instanceof SpheronApiError && err.details) {
        try {
          const detailJson = typeof err.details === 'string'
            ? err.details
            : JSON.stringify(err.details)
          detailedMessage = `${detailedMessage} — details: ${detailJson.slice(0, 600)}`
        } catch {
          /* ignore stringify edge case */
        }
      }

      const isStockShortage = matchesStockShortage(detailedMessage)
      if (isStockShortage && opts.gpuType) {
        markStockExhausted(opts.gpuType, detailedMessage)
      }

      try {
        await this.prisma.spheronDeployment.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            errorMessage: detailedMessage,
          },
        })
      } catch (dbErr) {
        log.warn(
          { deploymentId: row.id, err: dbErr },
          'deployServiceSpheron: failed to mark row FAILED after POST rejection',
        )
      }

      log.error(
        {
          serviceId,
          deploymentId: row.id,
          gpuType: opts.gpuType,
          isStockShortage,
          upstreamMessage: detailedMessage.slice(0, 400),
        },
        'deployServiceSpheron: synchronous POST rejected',
      )

      throw new SpheronCreateRejectedError(detailedMessage, {
        deploymentId: row.id,
        gpuType: opts.gpuType,
        isStockShortage,
        upstreamError: err instanceof Error ? err : undefined,
      })
    }

    // Step 3 — round-trip the upstream id (Phase 34 contract).
    await this.prisma.spheronDeployment.update({
      where: { id: row.id },
      data: {
        providerDeploymentId: created.id,
        status: 'STARTING',
      },
    })

    return row.id
  }

  /**
   * Startup-time resumption for in-process deployments stranded by a
   * cloud-api restart (dev:reset, crash, k8s rollout). The Spheron step
   * worker is a recursive in-process `setTimeout` chain in dev (and a
   * QStash-backed chain in prod with at-least-once delivery), so QStash
   * handles prod, but local dev needs an explicit kick.
   *
   * Each step handler is idempotent and inspects the row's
   * `providerDeploymentId` / `ipAddress` to decide which step to re-enter:
   *   - `CREATING` + no providerDeploymentId → DEPLOY_VM (re-POSTs)
   *   - `STARTING` + providerDeploymentId + no ipAddress → POLL_STATUS
   *   - `STARTING` + providerDeploymentId + ipAddress → RUN_CLOUDINIT_PROBE
   *
   * Mirrors `AkashOrchestrator.resumeDeployingDeployments`.
   */
  async resumeStuckDeployments(): Promise<void> {
    try {
      const stuck = await this.prisma.spheronDeployment.findMany({
        where: { status: { in: ['CREATING', 'STARTING'] } },
        select: {
          id: true,
          status: true,
          providerDeploymentId: true,
          ipAddress: true,
        },
      })

      if (stuck.length === 0) return

      log.info(`Found ${stuck.length} stuck Spheron deployment(s) — resuming step worker`)

      const { handleSpheronStep } = await import('../queue/webhookHandler.js')

      for (const d of stuck) {
        let payload: { step: string; deploymentId: string; attempt?: number }
        if (!d.providerDeploymentId) {
          payload = { step: 'DEPLOY_VM', deploymentId: d.id }
        } else if (!d.ipAddress) {
          payload = { step: 'POLL_STATUS', deploymentId: d.id, attempt: 1 }
        } else {
          payload = { step: 'RUN_CLOUDINIT_PROBE', deploymentId: d.id, attempt: 1 }
        }

        log.info({ deploymentId: d.id, step: payload.step }, 'Resuming Spheron step worker')
        handleSpheronStep(payload as never).catch(err =>
          log.error({ err, deploymentId: d.id }, 'Failed to resume Spheron step worker'),
        )
      }
    } catch (err) {
      log.error({ err }, 'resumeStuckDeployments error')
    }
  }

  // ── Status / probes ─────────────────────────────────────────

  /**
   * Read a deployment from Spheron. Returns `null` on transient errors so the
   * caller (provider adapter) can map to `OverallHealth: 'unknown'` per Phase
   * 31. Returns the upstream object on success, including when the upstream
   * status is `terminated` / `failed` / `terminated-provider` (those are
   * still successful API reads).
   *
   * 404 → throws SpheronApiError with status=404. Caller can catch and treat
   * as 'gone' or use `probeDeploymentExistence` for the typed verdict.
   */
  async getDeploymentStatus(spheronId: string): Promise<SpheronDeploymentObject | null> {
    const client = this.requireClient()
    try {
      return await client.getDeployment(spheronId)
    } catch (err) {
      if (err instanceof SpheronApiError && err.status === 404) {
        // Re-throw 404 — the caller can decide whether 404 = 'gone' (sweeper)
        // or 'unknown' (transient deletion race). Almost every caller wants
        // 'gone' so they should let it bubble.
        throw err
      }
      log.warn({ spheronId, err }, 'getDeploymentStatus failed transiently')
      return null
    }
  }

  /**
   * Phase 49b — the existence probe. Distinguishes "definitely gone at
   * provider" from "transient API blip". Used by:
   *
   *   - `provider.getHealth()` to upgrade the catch path from 'unknown' to
   *     'gone' when we have evidence the VM is really deleted.
   *   - The stale-deployment sweeper to confirm before close.
   *
   * Verdict matrix:
   *   API 200 → 'exists' (regardless of the inner Spheron status — status=
   *               terminated still has a queryable row but we treat that as
   *               'gone' separately via getDeploymentStatus's status field).
   *   API 404 → 'gone'
   *   anything else → 'unknown'
   */
  async probeDeploymentExistence(spheronId: string): Promise<'exists' | 'gone' | 'unknown'> {
    const client = this.requireClient()
    try {
      await client.getDeployment(spheronId)
      return 'exists'
    } catch (err) {
      if (err instanceof SpheronApiError && err.status === 404) return 'gone'
      log.warn({ spheronId, err }, 'probeDeploymentExistence transient failure')
      return 'unknown'
    }
  }

  // ── Termination ─────────────────────────────────────────────

  /**
   * DELETE the Spheron deployment. Idempotent in the project-wide
   * "already gone" sense — a 404 / "already deleted" / "not found" upstream
   * error returns successfully. The provider adapter's `close()` does the
   * billing settlement BEFORE calling this (Phase 31 contract).
   */
  async closeDeployment(spheronId: string): Promise<void> {
    const client = this.requireClient()

    // The pre-flight `can-terminate` is best-effort; if the endpoint isn't
    // available or returns an error, we still proceed to DELETE.
    const canTerminate = await client.canTerminate(spheronId)
    if (canTerminate && canTerminate.canTerminate === false) {
      log.warn(
        { spheronId, reason: canTerminate.reason },
        'can-terminate said no — proceeding anyway; DELETE will surface the real error',
      )
    }

    try {
      await client.deleteDeployment(spheronId)
    } catch (err) {
      if (err instanceof SpheronApiError && err.isAlreadyGone()) {
        log.info(
          { spheronId, err: err.message },
          'Spheron deployment already gone — treating DELETE as successful',
        )
        return
      }
      throw err
    }
  }

  // ── SSH-based shell / logs / health ─────────────────────────

  /**
   * Open an interactive SSH shell to the VM. Wraps `node-pty` so the local
   * end is a proper TTY — that lets the SSH client forward SIGWINCH (window
   * resize) to the remote shell, which `child_process.spawn` cannot do.
   */
  async getShell(conn: SshConnectionInfo, opts?: ShellOptions): Promise<ShellSession> {
    const keyPath = assertSshKeyExists()
    const sshArgs = [
      '-i', keyPath,
      ...SSH_BASE_OPTIONS,
      '-p', String(conn.sshPort),
      '-tt',
      `${conn.sshUser}@${conn.ipAddress}`,
    ]
    if (opts?.command) sshArgs.push(opts.command)

    const proc = pty.spawn('ssh', sshArgs, {
      name: 'xterm-256color',
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      env: process.env as Record<string, string>,
    })

    const dataListeners = new Set<(data: Buffer) => void>()
    const exitListeners = new Set<(code: number | null) => void>()

    proc.onData(data => {
      const buf = Buffer.from(data, 'utf-8')
      for (const cb of dataListeners) {
        try { cb(buf) } catch { /* never let one bad listener kill the loop */ }
      }
    })

    proc.onExit(({ exitCode }) => {
      for (const cb of exitListeners) {
        try { cb(exitCode) } catch { /* swallow */ }
      }
    })

    return {
      write(data) { proc.write(typeof data === 'string' ? data : data.toString('utf-8')) },
      onData(cb) { dataListeners.add(cb) },
      onExit(cb) { exitListeners.add(cb) },
      resize(cols, rows) { try { proc.resize(cols, rows) } catch { /* ignore — proc may already be exited */ } },
      kill() { try { proc.kill() } catch { /* ignore */ } },
    }
  }

  /**
   * One-shot `docker logs --tail N`. Returns string. For long-tail follow
   * use `streamLogs` instead (different process model — never pipe a
   * follow-process into a Promise<string>; you'll never see it resolve).
   */
  async getLogsViaSsh(conn: SshConnectionInfo, opts?: LogOptions): Promise<string> {
    const keyPath = assertSshKeyExists()
    const tail = opts?.tail ?? 200
    const service = opts?.service

    const remoteCommand = service
      ? `docker logs --tail ${tail} ${shellEscape(service)} 2>&1`
      // Default: aggregate all running containers' tails. For the typical
      // single-app workload this prints the whole log; for multi-service
      // composes the user should pass `--service` to disambiguate.
      : `for c in $(docker ps --format '{{.Names}}'); do echo "=== $c ==="; docker logs --tail ${tail} "$c" 2>&1; done`

    const sshArgs = [
      '-i', keyPath,
      ...SSH_BASE_OPTIONS,
      '-p', String(conn.sshPort),
      `${conn.sshUser}@${conn.ipAddress}`,
      remoteCommand,
    ]

    try {
      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024, // 8MB — generous for chatty workloads
      })
      return stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '')
    } catch (err) {
      // execFile rejects on non-zero exit; surface stderr if we have it.
      const e = err as { stdout?: string; stderr?: string; message?: string }
      return (
        (e.stdout ?? '') +
        (e.stderr ? `\n--- stderr ---\n${e.stderr}` : '') +
        (e.message ? `\n--- error ---\n${e.message}` : '')
      )
    }
  }

  /**
   * Long-lived `docker logs --follow`. Mirrors the LogStream contract
   * (services/providers/types.ts): emits per-line, single onClose, single
   * onError on fatal. Always release on `close()`.
   */
  streamLogsViaSsh(conn: SshConnectionInfo, opts?: LogStreamOptions): LogStream {
    const keyPath = assertSshKeyExists()
    const service = opts?.service
    const tail = opts?.tail ?? 50
    const remoteCommand = service
      ? `docker logs --follow --tail ${tail} ${shellEscape(service)}`
      : `bash -c 'for c in $(docker ps --format "{{.Names}}"); do (docker logs --follow --tail ${tail} "$c" | sed "s/^/[$c] /") & done; wait'`

    const sshArgs = [
      '-i', keyPath,
      ...SSH_BASE_OPTIONS,
      '-p', String(conn.sshPort),
      `${conn.sshUser}@${conn.ipAddress}`,
      remoteCommand,
    ]

    const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    const lineListeners = new Set<(line: string) => void>()
    const errorListeners = new Set<(err: Error) => void>()
    const closeListeners = new Set<(code: number | null) => void>()

    let buffer = ''
    let closed = false
    const emitLine = (line: string) => {
      for (const cb of lineListeners) {
        try { cb(line) } catch { /* swallow */ }
      }
    }

    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        emitLine(line)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }

    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', err => {
      if (closed) return
      for (const cb of errorListeners) {
        try { cb(err) } catch { /* swallow */ }
      }
    })
    child.on('close', code => {
      if (closed) return
      closed = true
      // Flush any tail without trailing newline.
      if (buffer.length > 0) {
        emitLine(buffer)
        buffer = ''
      }
      for (const cb of closeListeners) {
        try { cb(code) } catch { /* swallow */ }
      }
    })

    return {
      onLine(cb) { lineListeners.add(cb) },
      onError(cb) { errorListeners.add(cb) },
      onClose(cb) { closeListeners.add(cb) },
      close() {
        if (closed) return
        closed = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        // Hard kill if ssh ignores SIGTERM (rare but possible mid-handshake).
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 2_000).unref()
      },
    }
  }

  /**
   * Probe `docker ps --format json` over SSH to determine container-level
   * health on a Spheron VM. Returns null on any SSH error so the caller maps
   * to OverallHealth: 'unknown' (Phase 31 contract — never fake 'healthy').
   *
   * `allRunning` distinguishes 'healthy' from 'unhealthy'/'starting' for
   * the provider adapter:
   *   - allRunning=true && containers.length > 0 → 'healthy'
   *   - allRunning=false && containers.length > 0 → 'unhealthy' (per Phase 49,
   *     this is NOT a sweeper-close signal — user inspects)
   *   - containers.length === 0 → 'starting' (compose hasn't finished apt
   *     install + pull yet; the cloud-init may still be running)
   */
  async getDockerHealthViaSsh(conn: SshConnectionInfo): Promise<DockerHealthSnapshot | null> {
    const keyPath = assertSshKeyExists()
    const sshArgs = [
      '-i', keyPath,
      ...SSH_BASE_OPTIONS,
      '-p', String(conn.sshPort),
      `${conn.sshUser}@${conn.ipAddress}`,
      // Per-container JSON, one object per line. Easier to parse than
      // `--format=json` (which returns a single JSON array on newer Docker
      // releases but a stream of objects on others).
      "docker ps --no-trunc --format '{{json .}}' 2>/dev/null || true",
    ]

    try {
      const { stdout } = await execFileAsync('ssh', sshArgs, {
        timeout: 15_000,
        maxBuffer: 1 * 1024 * 1024,
      })

      const containers: DockerHealthSnapshot['containers'] = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed) as { Names?: string; State?: string; Status?: string }
          containers.push({
            name: obj.Names ?? '',
            state: obj.State ?? 'unknown',
            status: obj.Status ?? '',
          })
        } catch {
          // Skip unparseable lines (e.g. random noise from a busted MOTD).
        }
      }

      const allRunning = containers.length > 0 && containers.every(c => c.state === 'running')
      return {
        containers,
        allRunning,
        warning: containers.length === 0 ? 'docker ps returned no containers (compose may still be coming up)' : undefined,
      }
    } catch (err) {
      log.warn({ ipAddress: conn.ipAddress, err }, 'getDockerHealthViaSsh failed — caller maps to OverallHealth=unknown')
      return null
    }
  }
}

// ─── Tiny shell-quote helper ─────────────────────────────────────────

/**
 * Single-quote a value for use in a remote `bash -c` context. Replaces
 * embedded single quotes with the standard `'\''` dance. Used for
 * service-name interpolation in `docker logs`.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ─── Singleton accessor ──────────────────────────────────────────────

let _instance: SpheronOrchestrator | null = null

export function getSpheronOrchestrator(prisma: PrismaClient): SpheronOrchestrator {
  if (!_instance) _instance = new SpheronOrchestrator(prisma)
  return _instance
}

export function resetSpheronOrchestrator(): void {
  _instance = null
}
