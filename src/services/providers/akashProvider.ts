/**
 * Akash DeploymentProvider Adapter
 *
 * Wraps the existing AkashOrchestrator behind the DeploymentProvider interface.
 * This is a thin adapter — all real logic lives in orchestrator.ts.
 *
 * Status mapping (Akash native → ProviderStatus):
 *   CREATING, WAITING_BIDS, SELECTING_BID, CREATING_LEASE,
 *     SENDING_MANIFEST, DEPLOYING                         → 'creating'
 *   ACTIVE                                                → 'active'
 *   FAILED                                                → 'failed'
 *   CLOSED                                                → 'closed'
 *   SUSPENDED                                             → 'suspended'
 */

import type { PrismaClient } from '@prisma/client'
import type {
  DeploymentProvider,
  DeploymentProviderDescriptor,
  DeployOptions,
  DeploymentResult,
  DeploymentStatusResult,
  DeploymentHealthResult,
  ContainerHealth,
  ContainerStatus,
  OverallHealth,
  LogOptions,
  LogStream,
  LogStreamOptions,
  ShellOptions,
  ShellSession,
  ProviderCapabilities,
  ProviderStatus,
} from './types.js'
import { getAkashOrchestrator } from '../akash/orchestrator.js'
import { getEscrowService } from '../billing/escrowService.js'
import { settleAkashEscrowToTime } from '../billing/deploymentSettlement.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('akash-provider')

const AKASH_STATUS_MAP: Record<string, ProviderStatus> = {
  CREATING: 'creating',
  WAITING_BIDS: 'creating',
  SELECTING_BID: 'creating',
  CREATING_LEASE: 'creating',
  SENDING_MANIFEST: 'creating',
  DEPLOYING: 'creating',
  ACTIVE: 'active',
  FAILED: 'failed',
  CLOSED: 'closed',
  SUSPENDED: 'suspended',
}

function mapStatus(nativeStatus: string): ProviderStatus {
  return AKASH_STATUS_MAP[nativeStatus] ?? 'failed'
}

/**
 * Akash-native pending statuses — every step from "we submitted the
 * TX" through "manifest pushed". The `activeAkashDeployment` GraphQL
 * field resolver matches `ACTIVE` only; this set is for the `updateService`
 * + `deleteService` guards that block mutations mid-flight.
 */
export const AKASH_PENDING_STATUSES: readonly string[] = [
  'CREATING',
  'WAITING_BIDS',
  'SELECTING_BID',
  'CREATING_LEASE',
  'SENDING_MANIFEST',
  'DEPLOYING',
]

export const AKASH_DESCRIPTOR: DeploymentProviderDescriptor = {
  name: 'akash',
  prismaModel: 'akashDeployment',
  liveStatuses: ['ACTIVE'],
  pendingStatuses: AKASH_PENDING_STATUSES,
  failedStatuses: ['FAILED', 'PERMANENTLY_FAILED'],
  terminalStatuses: ['CLOSED', 'FAILED', 'PERMANENTLY_FAILED', 'SUSPENDED'],
  // Akash CLOSED rows are already off-chain; FAILED/PERMANENTLY_FAILED
  // rows may still have a dangling lease that close() will reap.
  // SUSPENDED is deliberately excluded — those rows are resumable and
  // owners may want to re-activate post-suspend.
  needsCleanupStatuses: ['FAILED', 'PERMANENTLY_FAILED'],
  unifiedStatusMap: {
    CREATING: 'INITIALIZING',
    WAITING_BIDS: 'QUEUED',
    SELECTING_BID: 'QUEUED',
    CREATING_LEASE: 'DEPLOYING',
    SENDING_MANIFEST: 'DEPLOYING',
    DEPLOYING: 'DEPLOYING',
    ACTIVE: 'ACTIVE',
    FAILED: 'FAILED',
    CLOSED: 'REMOVED',
    PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
    SUSPENDED: 'STOPPED',
  },
  displayName: 'Akash Network',
  computeKind: 'Standard',
}

export class AkashProvider implements DeploymentProvider {
  readonly name = 'akash'
  readonly displayName = 'Akash Network'
  readonly descriptor = AKASH_DESCRIPTOR

  constructor(private prisma: PrismaClient) {}

  isAvailable(): boolean {
    return !!process.env.AKASH_MNEMONIC
  }

  async getActiveDeploymentIds(): Promise<string[]> {
    const active = await this.prisma.akashDeployment.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
    return active.map(d => d.id)
  }

  async deploy(serviceId: string, options: DeployOptions): Promise<DeploymentResult> {
    const orchestrator = getAkashOrchestrator(this.prisma)

    if (options.sourceCode) {
      const service = await this.prisma.service.findUnique({
        where: { id: serviceId },
        include: { afFunction: true },
      })
      if (service?.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { sourceCode: options.sourceCode },
        })
      }
    }

    const deploymentId = await orchestrator.deployService(serviceId, {
      deposit: options.deposit,
      sdlContent: options.sdlContent,
    })

    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })

    if (!deployment) {
      return {
        deploymentId,
        providerDeploymentId: 'unknown',
        status: 'failed',
        errorMessage: 'Deployment record not found after creation',
      }
    }

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.serviceUrls && typeof deployment.serviceUrls === 'object') {
      for (const [k, v] of Object.entries(deployment.serviceUrls as Record<string, { uris?: string[] }>)) {
        serviceUrls[k] = v.uris || []
      }
    }

    return {
      deploymentId: deployment.id,
      providerDeploymentId: deployment.dseq.toString(),
      status: mapStatus(deployment.status),
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      errorMessage: deployment.errorMessage ?? undefined,
    }
  }

  async stop(_deploymentId: string): Promise<void> {
    throw new Error('Akash does not support stop/resume. Use close() to permanently terminate.')
  }

  async close(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Akash deployment not found: ${deploymentId}`)
    if (deployment.status === 'CLOSED') return

    const closedAt = new Date()

    const orchestrator = getAkashOrchestrator(this.prisma)

    try {
      await orchestrator.closeDeployment(Number(deployment.dseq))
    } catch (err) {
      log.warn(err as Error, `on-chain close failed for dseq=${deployment.dseq}, force-closing DB`)
    }

    await this.prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'CLOSED', closedAt },
    })

    await settleAkashEscrowToTime(this.prisma, deploymentId, closedAt)
    await getEscrowService(this.prisma).refundEscrow(deploymentId)

    if (deployment.policyId) {
      await this.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: closedAt },
      })
    }
  }

  private static healthCache = new Map<string, { result: DeploymentHealthResult; fetchedAt: number }>()
  private static HEALTH_CACHE_TTL_MS = 15_000
  private static HEALTH_CACHE_MAX_SIZE = 100

  private static pruneHealthCache() {
    if (AkashProvider.healthCache.size <= AkashProvider.HEALTH_CACHE_MAX_SIZE) return
    const now = Date.now()
    for (const [key, entry] of AkashProvider.healthCache) {
      if (now - entry.fetchedAt > AkashProvider.HEALTH_CACHE_TTL_MS) {
        AkashProvider.healthCache.delete(key)
      }
    }
    if (AkashProvider.healthCache.size > AkashProvider.HEALTH_CACHE_MAX_SIZE) {
      const oldest = [...AkashProvider.healthCache.entries()]
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      while (AkashProvider.healthCache.size > AkashProvider.HEALTH_CACHE_MAX_SIZE && oldest.length) {
        AkashProvider.healthCache.delete(oldest.shift()![0])
      }
    }
  }

  async getHealth(deploymentId: string): Promise<DeploymentHealthResult | null> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment || !deployment.provider) return null

    const nonHealthStates = new Set(['CLOSED', 'FAILED', 'PERMANENTLY_FAILED'])
    if (nonHealthStates.has(deployment.status)) {
      // CLOSED → 'unknown' (sweeper won't act on it; CLOSED rows aren't
      // in the active set anyway). FAILED/PERMANENTLY_FAILED → 'gone'
      // because the chain-side lease is genuinely no longer usable —
      // those states are only ever set after we observed a permanent
      // chain-side failure during the SUBMIT_TX → LEASE_CREATED pipeline.
      return {
        provider: 'akash',
        overall: deployment.status === 'CLOSED' ? 'unknown' : 'gone',
        containers: [],
        lastChecked: new Date(),
      }
    }

    const isPreActive = !['ACTIVE', 'SUSPENDED'].includes(deployment.status)
    if (isPreActive) {
      return {
        provider: 'akash',
        overall: 'starting',
        containers: [],
        lastChecked: new Date(),
      }
    }

    const cached = AkashProvider.healthCache.get(deploymentId)
    const now = Date.now()
    if (cached && now - cached.fetchedAt < AkashProvider.HEALTH_CACHE_TTL_MS) {
      return cached.result
    }

    try {
      const orchestrator = getAkashOrchestrator(this.prisma)
      const raw = await orchestrator.getLeaseHealth(
        Number(deployment.dseq),
        deployment.provider
      )

      const containers: ContainerHealth[] = raw.map(c => {
        let status: ContainerStatus = 'unknown'
        if (c.ready) {
          status = 'running'
        } else if (c.available > 0) {
          status = 'starting'
        } else if (c.total > 0) {
          status = 'waiting'
        }

        return {
          name: c.name,
          status,
          ready: c.ready,
          total: c.total,
          available: c.available,
          uris: c.uris,
        }
      })

      const allReady = containers.length > 0 && containers.every(c => c.ready)
      const anyReady = containers.some(c => c.ready)
      const anyWaiting = containers.some(c => c.status === 'waiting' || c.status === 'starting')
      let overall: OverallHealth = 'unknown'
      if (allReady) overall = 'healthy'
      else if (anyReady && anyWaiting) overall = 'degraded'
      else if (anyWaiting) overall = 'starting'
      else if (containers.length === 0) {
        // Empty `services: {}` from a successful lease-status call is NOT a
        // death signal — Akash providers return this during k8s manifest
        // re-pushes, brief container restarts, or any moment when their
        // internal cache is empty. Classify as `unknown` so the sweeper's
        // observability counter tracks it without ever feeding the close
        // path, instead of falling into the `unhealthy` bucket
        // which (pre-Phase-49) used to kill the lease in 1 tick. (2026-05-03
        // incident — single sweep pass killed 6 prod leases in 4 min, all
        // reason=unhealthy.)
        overall = 'unknown'
      } else overall = 'unhealthy'

      const result: DeploymentHealthResult = { provider: 'akash', overall, containers, lastChecked: new Date() }
      AkashProvider.healthCache.set(deploymentId, { result, fetchedAt: now })
      AkashProvider.pruneHealthCache()
      return result
    } catch (err) {
      const msg = (err as Error).message ?? ''
      log.warn(`getHealth failed for ${deploymentId}: ${msg.slice(0, 200)}`)
      AkashProvider.healthCache.delete(deploymentId)
      const isGone = msg.includes('404') || msg.includes('not found')

      // 2026-05-03 fix — DELIBERATELY do NOT auto-close from inside getHealth.
      // The previous implementation here fired `autoCloseGhostDeployment` as
      // fire-and-forget on a single 404, with NO audit row, NO failure-counter
      // debounce, and NO failover-policy check. Forensics on prod showed 7
      // ACTIVE leases killed by that path with zero audit trail in the last
      // 30 days. The sweeper's threshold mechanism (`reconcileActiveDeployments`)
      // already requires N consecutive observations, writes a proper audit
      // row, and respects failover policy — let it handle ghost-detection
      // through the normal `gone` verdict path.
      //
      // 2026-05-03 follow-up — `isGone` (provider 404 / "not found") now
      // returns 'gone' rather than 'unhealthy'. Container-unhealthy is no
      // longer a sweeper-close signal (only opt-in failover acts on it);
      // the sweeper still closes confirmed-gone leases via the new 'gone'
      // verdict. Anything else (timeouts, RPC blips) stays 'unknown' and
      // is never closed.
      return {
        provider: 'akash',
        overall: isGone ? 'gone' : 'unknown',
        containers: [],
        lastChecked: new Date(),
      }
    }
  }

  async getStatus(deploymentId: string): Promise<DeploymentStatusResult> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Akash deployment not found: ${deploymentId}`)

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.serviceUrls && typeof deployment.serviceUrls === 'object') {
      for (const [k, v] of Object.entries(deployment.serviceUrls as Record<string, { uris?: string[] }>)) {
        serviceUrls[k] = v.uris || []
      }
    }

    return {
      status: mapStatus(deployment.status),
      nativeStatus: deployment.status,
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      metadata: {
        dseq: deployment.dseq.toString(),
        provider: deployment.provider,
        owner: deployment.owner,
        pricePerBlock: deployment.pricePerBlock,
        depositUakt: deployment.depositUakt?.toString(),
      },
    }
  }

  async getLogs(deploymentId: string, opts?: LogOptions): Promise<string> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment || !deployment.provider) {
      throw new Error(`Akash deployment not found or has no provider: ${deploymentId}`)
    }

    const orchestrator = getAkashOrchestrator(this.prisma)
    return orchestrator.getLogs(
      Number(deployment.dseq),
      deployment.provider,
      opts?.service,
      opts?.tail,
      deployment.gseq,
      deployment.oseq,
    )
  }

  async streamLogs(deploymentId: string, opts?: LogStreamOptions): Promise<LogStream> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      include: { service: { select: { sdlServiceName: true, slug: true } } },
    })
    if (!deployment || !deployment.provider) {
      throw new Error(`Akash deployment not found or has no provider: ${deploymentId}`)
    }
    if (deployment.status !== 'ACTIVE') {
      throw new Error(`Cannot stream logs: deployment is ${deployment.status}, not ACTIVE`)
    }

    const sdlServiceName = opts?.service
      || deployment.service?.sdlServiceName
      || deployment.service?.slug
      || undefined

    const orchestrator = getAkashOrchestrator(this.prisma)
    return orchestrator.streamLogs(
      Number(deployment.dseq),
      deployment.provider,
      sdlServiceName,
      opts?.tail ?? 50,
    )
  }

  async getShell(deploymentId: string, opts?: ShellOptions): Promise<ShellSession> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      include: { service: { select: { sdlServiceName: true, slug: true } } },
    })
    if (!deployment || !deployment.provider) {
      throw new Error(`Akash deployment not found or has no provider: ${deploymentId}`)
    }
    if (deployment.status !== 'ACTIVE') {
      throw new Error(`Cannot open shell: deployment is ${deployment.status}, not ACTIVE`)
    }

    const sdlServiceName = opts?.service
      || deployment.service?.sdlServiceName
      || deployment.service?.slug
      || undefined

    const orchestrator = getAkashOrchestrator(this.prisma)
    return orchestrator.getShell(
      Number(deployment.dseq),
      deployment.provider,
      sdlServiceName,
      opts?.command,
    )
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStop: false,
      supportsLogStreaming: true,
      supportsTEE: false,
      supportsPersistentStorage: true,
      supportsWebSocket: true,
      supportsShell: true,
      configFormat: 'sdl',
      billingModel: 'escrow',
    }
  }

  extractImage(deployment: Record<string, unknown>): string | null {
    const sdl = typeof deployment.sdlContent === 'string' ? deployment.sdlContent : ''
    const match = sdl.match(/image:\s*["']?([^\s"']+)/)
    return match ? match[1] : null
  }

  describeUnifiedStatus(
    deployment: { status: string; errorMessage?: string | null },
  ): string | null {
    if (deployment.errorMessage) return deployment.errorMessage
    if (deployment.status === 'ACTIVE') return 'Running on Akash'
    return null
  }
}

export function createAkashProvider(prisma: PrismaClient): AkashProvider {
  return new AkashProvider(prisma)
}

const HEALTH_PREWARM_INTERVAL_MS = 30_000

/**
 * Pre-warms the health cache for all ACTIVE Akash deployments so the first
 * panel open returns instantly from cache instead of waiting 2-3s for
 * `provider-services lease-status`.
 */
export function startHealthPrewarmer(prisma: PrismaClient): ReturnType<typeof setInterval> {
  const provider = new AkashProvider(prisma)

  const warm = async () => {
    try {
      const activeDeployments = await prisma.akashDeployment.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      })
      for (const dep of activeDeployments) {
        try {
          await provider.getHealth(dep.id)
        } catch {
          // individual failures are fine — cache will just miss for this one
        }
      }
    } catch (err) {
      log.warn({ err }, 'Health pre-warmer cycle failed')
    }
  }

  warm()
  return setInterval(warm, HEALTH_PREWARM_INTERVAL_MS)
}
