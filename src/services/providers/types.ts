/**
 * DeploymentProvider — unified interface for all compute providers.
 *
 * Every provider (Akash, Phala, Aether, IO.net, etc.) implements this interface.
 * The provider registry maps provider names to implementations so resolvers,
 * templates, and the subdomain proxy can work with any backend generically.
 *
 * When adding a new provider, implement this interface and register it.
 * See PROVIDER_IMPLEMENTATION_PROTOCOL.md for the full checklist.
 */

import type { PrismaClient } from '@prisma/client'

// ─── Core status type ────────────────────────────────────────────
// Normalized across all providers. Each provider maps its native
// statuses to these canonical values.

export type ProviderStatus =
  | 'creating'
  | 'starting'
  | 'active'
  | 'failed'
  | 'stopped'
  | 'closed'
  | 'deleted'
  | 'suspended'

// ─── Deploy options ──────────────────────────────────────────────

export interface DeployOptions {
  /** Akash: deposit in uAKT. Phala: ignored (hourly billing). */
  deposit?: number
  /** Akash SDL YAML content. Takes priority over auto-generated SDL. */
  sdlContent?: string
  /** Phala docker-compose YAML content. */
  composeContent?: string
  /** Environment variables to inject into the deployment. */
  env?: Record<string, string>
  /** Source code to save before deploying (for FUNCTION services). */
  sourceCode?: string
}

// ─── Log options ─────────────────────────────────────────────────

export interface LogOptions {
  /** Max number of log lines (tail). */
  tail?: number
  /** Specific service/container within the deployment. */
  service?: string
  /** Stream logs in real-time (not all providers support this). */
  follow?: boolean
}

// ─── Shell options ───────────────────────────────────────────────

export interface ShellOptions {
  /** Command to execute (default: /bin/sh) */
  command?: string
  /** Specific service/container within the deployment */
  service?: string
  /** Terminal columns (for resize) */
  cols?: number
  /** Terminal rows (for resize) */
  rows?: number
}

export interface ShellSession {
  /** Write data to the shell's stdin */
  write(data: Buffer | string): void
  /** Listen for data from the shell's stdout */
  onData(callback: (data: Buffer) => void): void
  /** Listen for the shell process exiting */
  onExit(callback: (code: number | null) => void): void
  /** Resize the terminal (not all providers support this) */
  resize?(cols: number, rows: number): void
  /** Kill the shell process and clean up */
  kill(): void
}

// ─── Log streaming ───────────────────────────────────────────────

export interface LogStreamOptions {
  /** Specific service/container within the deployment. */
  service?: string
  /** Optional initial tail before live-follow begins. */
  tail?: number
}

/**
 * Long-lived log stream. The provider spawns whatever underlying process
 * (CLI subprocess, websocket, REST chunked response) and exposes a uniform
 * line-oriented interface that the SSE endpoint can fan out to clients.
 *
 * Implementations MUST:
 *   - emit `onLine` for every full line of provider output (no trailing \n)
 *   - emit `onError` for fatal stream errors (after which the stream is dead)
 *   - emit `onClose` exactly once with the underlying exit code (or null)
 *   - stop emitting and release all resources after `close()` is called
 */
export interface LogStream {
  onLine(callback: (line: string) => void): void
  onError(callback: (err: Error) => void): void
  onClose(callback: (code: number | null) => void): void
  close(): void
}

// ─── Deployment result ───────────────────────────────────────────

export interface DeploymentResult {
  /** Internal deployment record ID (cuid). */
  deploymentId: string
  /** Provider-specific identifier (dseq for Akash, appId for Phala). */
  providerDeploymentId: string
  /** Canonical status after deploy completes or fails. */
  status: ProviderStatus
  /** Public URL(s) where the service is reachable. */
  serviceUrls?: Record<string, string[]>
  /** Error message if status is 'failed'. */
  errorMessage?: string
}

// ─── Status result ───────────────────────────────────────────────

export interface DeploymentStatusResult {
  status: ProviderStatus
  serviceUrls?: Record<string, string[]>
  /** Provider-native status string (e.g. 'ACTIVE', 'CREATING', 'running'). */
  nativeStatus?: string
  /** Additional provider-specific metadata. */
  metadata?: Record<string, unknown>
}

// ─── Container health (per-container within a deployment) ────────

export type ContainerStatus =
  | 'running'
  | 'starting'
  | 'waiting'
  | 'crashed'
  | 'image_error'
  | 'error'
  | 'unknown'

export interface ContainerHealth {
  name: string
  status: ContainerStatus
  ready: boolean
  total: number
  available: number
  uris: string[]
  message?: string
}

export type OverallHealth =
  | 'healthy'
  | 'starting'
  | 'degraded'
  // Container is reachable but reporting failure (probe failed, all replicas
  // crash-looping, etc.). NOT a sweeper-close signal — the lease still
  // exists on-chain and the user needs it alive to inspect logs and
  // redeploy. Surfaced in the UI and audit log; opt-in failoverPolicy may
  // act on it, otherwise we leave the lease alone.
  | 'unhealthy'
  // Lease no longer exists at the provider (confirmed via 404 / "not
  // found" on lease-status). The actual on-chain lease is gone — closing
  // our DB row is just bookkeeping. THIS is the sweeper's close signal.
  | 'gone'
  | 'unknown'

export interface DeploymentHealthResult {
  provider: string
  overall: OverallHealth
  containers: ContainerHealth[]
  lastChecked: Date
}

// ─── The interface every provider must implement ─────────────────

export interface DeploymentProvider {
  /** Unique provider name: 'akash' | 'phala' | 'aether' | 'ionet' | etc. */
  readonly name: string

  /** Human-readable display name. */
  readonly displayName: string

  /**
   * Provider metadata + native status taxonomy. The registry uses this
   * to drive the cross-provider helpers (`findActiveDeploymentForService`,
   * `findRecentDeploymentsForService`, etc.) without per-call-site
   * if/else chains.
   */
  readonly descriptor: DeploymentProviderDescriptor

  /** Whether this provider is currently configured and operational. */
  isAvailable(): boolean

  /**
   * Deploy a service.
   * The provider is responsible for:
   *   1. Creating its own deployment DB record
   *   2. Running the actual deployment (CLI, SDK, API)
   *   3. Polling for readiness
   *   4. Updating the DB record with final status + URLs
   *
   * Returns the internal deployment record ID.
   */
  deploy(serviceId: string, options: DeployOptions): Promise<DeploymentResult>

  /**
   * Stop a running deployment (pause, can be resumed).
   * Not all providers support stop — throw if unsupported.
   */
  stop(deploymentId: string): Promise<void>

  /**
   * Resume a stopped deployment.
   * Not all providers support resume — throw if unsupported.
   */
  start?(deploymentId: string): Promise<void>

  /**
   * Permanently close/delete a deployment.
   * BILLING CONTRACT: This method MUST settle all outstanding billing for the
   * deployment before returning. This includes final prorated charges, escrow
   * settlement, refunds, and any provider-specific billing cleanup. The
   * provider-agnostic reconciler relies on this guarantee — when it detects a
   * dead deployment and calls close(), billing is fully handled.
   */
  close(deploymentId: string): Promise<void>

  /**
   * Get current deployment status from the provider.
   */
  getStatus(deploymentId: string): Promise<DeploymentStatusResult>

  /**
   * Return IDs of all deployments that the DB considers active/running.
   * The provider-agnostic reconciler calls this to discover what to health-check.
   * Must include any status where the provider could be consuming resources
   * (i.e. the deployment is billable).
   */
  getActiveDeploymentIds(): Promise<string[]>

  /**
   * Live per-container health from the provider API.
   * REQUIRED: every provider MUST implement liveness checks. A provider that
   * cannot report health is a billing liability — the reconciler uses this to
   * detect dead deployments and stop ghost billing.
   * Return { overall: 'unknown' } on transient errors (NOT 'healthy').
   */
  getHealth(deploymentId: string): Promise<DeploymentHealthResult | null>

  /**
   * Extract a primary container image reference from a deployment row,
   * if one can be inferred from the provider's stored config blob
   * (SDL for Akash, compose for Phala/Spheron). Used by the unified
   * `allDeployments` resolver to surface "what's running" without
   * per-provider casework in the resolver. Optional — defaults to null.
   */
  extractImage?(deployment: Record<string, unknown>): string | null

  /**
   * Render a friendly status message for the unified timeline. Each
   * provider can return its own copy ("Running on Akash", "Spheron 20-min
   * floor blocking"); falls back to deployment.errorMessage if omitted.
   */
  describeUnifiedStatus?(
    deployment: { status: string; errorMessage?: string | null } & Record<string, unknown>,
  ): string | null

  /**
   * Get deployment logs.
   */
  getLogs(deploymentId: string, opts?: LogOptions): Promise<string>

  /**
   * Open an interactive shell session into a running deployment.
   * Not all providers support this — check capabilities.supportsShell.
   * Returns a ShellSession that the caller pipes to a WebSocket or terminal.
   */
  getShell?(deploymentId: string, opts?: ShellOptions): Promise<ShellSession>

  /**
   * Open a long-lived log stream. The SSE endpoint pipes each emitted line
   * to connected clients. Only providers with `supportsLogStreaming: true`
   * implement this — others fall back to point-in-time `getLogs`.
   */
  streamLogs?(deploymentId: string, opts?: LogStreamOptions): Promise<LogStream>

  /**
   * Provider-specific capabilities and metadata.
   */
  getCapabilities(): ProviderCapabilities
}

// ─── Capabilities ────────────────────────────────────────────────

export interface ProviderCapabilities {
  /** Supports stop/resume (Phala yes, Akash no — close is permanent). */
  supportsStop: boolean
  /** Supports log streaming. */
  supportsLogStreaming: boolean
  /** Supports TEE/confidential computing. */
  supportsTEE: boolean
  /** Supports persistent storage volumes. */
  supportsPersistentStorage: boolean
  /** Supports WebSocket proxying. */
  supportsWebSocket: boolean
  /** Supports interactive shell access into running containers. */
  supportsShell: boolean
  /** Config format this provider uses. */
  configFormat: 'sdl' | 'compose' | 'manifest' | 'custom'
  /** Billing model. */
  billingModel: 'escrow' | 'hourly' | 'per-block' | 'prepaid' | 'custom'
}

// ─── Provider descriptor (status sets + Prisma model) ────────────
// Every provider declares its native status taxonomy and the Prisma
// model that stores its deployments. The registry uses this to answer
// "is service X live on any provider", "fetch the active deployment for
// service X", and "map a native status to the unified
// DeploymentLifecycle". Mirror new providers into
// web-app/lib/providers/serviceState.ts and
// package-cloud-cli/src/utils/serviceState.ts.

/**
 * Unified deployment lifecycle states surfaced in the UI / CLI.
 * Every provider's native statuses map to one of these via
 * `descriptor.unifiedStatusMap`. Extending this set forces every consumer
 * to update its icon + label tables.
 */
export type DeploymentLifecycle =
  | 'INITIALIZING'  // record created, no provider call yet
  | 'QUEUED'        // waiting for upstream resource (bids, slot, etc.)
  | 'DEPLOYING'     // provider has accepted, container coming up
  | 'ACTIVE'        // running and billable
  | 'STOPPED'       // intentionally paused (Phala stop, Spheron threshold pause)
  | 'FAILED'        // provider rejected or container failed (recoverable)
  | 'REMOVED'       // permanently deleted / lease closed
  | 'PERMANENTLY_FAILED' // failed and cannot recover (e.g. failover cap exhausted)

export interface DeploymentProviderDescriptor {
  /** Provider key (matches `DeploymentProvider.name`). */
  name: string

  /**
   * Name of the Prisma model that stores this provider's deployment rows.
   * Used by registry helpers to do `prisma[descriptor.prismaModel].findFirst(...)`
   * without an `if/else` chain.
   */
  prismaModel: 'akashDeployment' | 'phalaDeployment' | 'spheronDeployment'

  /**
   * Native statuses that mean "live & billable in the UI/billing sense".
   * Spheron includes CREATING/STARTING because hourly billing accrues
   * the moment we POST to upstream; Akash + Phala only bill once they
   * reach ACTIVE. The `activeXDeployment` GraphQL field resolver
   * filters its query by exactly this set.
   */
  liveStatuses: readonly string[]

  /**
   * Native statuses that mean "deployment is mid-flight, do not allow
   * the user to mutate config / delete the service". Used by the
   * `updateService` and `deleteService` guards.
   */
  pendingStatuses: readonly string[]

  /**
   * Native statuses that mean "permanently failed; recover by close +
   * re-deploy". The sweeper's `close_gone` path syncs these.
   */
  failedStatuses: readonly string[]

  /**
   * Native statuses that mean "no longer running, no further action".
   * Excluded from `findActiveDeploymentForService` and `liveServicesCount`.
   */
  terminalStatuses: readonly string[]

  /**
   * Statuses where the deployment row has been moved out of the "live"
   * set but the upstream resource may still exist — for example, a Phala
   * CVM in STOPPED state still consumes a slot until DELETE, and a FAILED
   * Akash row can still have an on-chain lease that needs `close`-ing.
   *
   * Consumed by `deleteService` to best-effort `provider.close()` each
   * orphan before destroying the service row, so adding a new provider
   * doesn't leak upstream resources.
   */
  needsCleanupStatuses: readonly string[]

  /**
   * Map every known native status to the unified DeploymentLifecycle.
   * Consumers (allDeployments resolver, web-app StatusBadge, CLI list)
   * should consult this rather than maintaining their own switches.
   */
  unifiedStatusMap: Record<string, DeploymentLifecycle>

  /**
   * Display strings. `computeKind` is the Compute column value in the
   * CLI + web-app workspace ("Standard" vs "Confidential").
   */
  displayName: string
  computeKind: 'Standard' | 'Confidential'
}

// ─── Provider factory ────────────────────────────────────────────
// Each provider exports a factory that takes PrismaClient and returns
// a DeploymentProvider. This keeps providers stateless and testable.

export type DeploymentProviderFactory = (prisma: PrismaClient) => DeploymentProvider
