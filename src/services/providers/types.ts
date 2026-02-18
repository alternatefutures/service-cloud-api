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

// ─── The interface every provider must implement ─────────────────

export interface DeploymentProvider {
  /** Unique provider name: 'akash' | 'phala' | 'aether' | 'ionet' | etc. */
  readonly name: string

  /** Human-readable display name. */
  readonly displayName: string

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
   * This should clean up on-chain/provider resources and update the DB.
   */
  close(deploymentId: string): Promise<void>

  /**
   * Get current deployment status from the provider.
   */
  getStatus(deploymentId: string): Promise<DeploymentStatusResult>

  /**
   * Get deployment logs.
   */
  getLogs(deploymentId: string, opts?: LogOptions): Promise<string>

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
  /** Config format this provider uses. */
  configFormat: 'sdl' | 'compose' | 'manifest' | 'custom'
  /** Billing model. */
  billingModel: 'escrow' | 'hourly' | 'per-block' | 'prepaid' | 'custom'
}

// ─── Provider factory ────────────────────────────────────────────
// Each provider exports a factory that takes PrismaClient and returns
// a DeploymentProvider. This keeps providers stateless and testable.

export type DeploymentProviderFactory = (prisma: PrismaClient) => DeploymentProvider
