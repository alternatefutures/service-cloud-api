/**
 * Spheron DeploymentProvider Adapter
 *
 * Wraps `SpheronOrchestrator` (services/spheron/orchestrator.ts) and
 * `SpheronClient` behind the platform-wide `DeploymentProvider` interface.
 * Mirrors `phalaProvider.ts` line-for-line (Phala is the closer analogue
 * than Akash because both are hourly-billed, single-API providers) with
 * three Spheron-specific differences:
 *
 *   1. **No native stop.** Spheron only supports deploy + DELETE — `stop()`
 *      throws. Resume after low-balance pause = re-deploy from
 *      `savedCloudInit` + `savedDeployInput` (handled by Phase B
 *      `resumeHandler`).
 *
 *   2. **SSH-based health probe.** No "get app status" REST endpoint that
 *      reports container health — `getHealth` consults the Spheron API for
 *      VM-level status, then SSH-probes `docker ps` for container-level
 *      health when the VM is ACTIVE. Mirrors `getDockerHealthViaSsh`.
 *
 *   3. **`'gone'` mapping.** Per Phase 49 + 49b, the sweeper-close signal
 *      is `'gone'` (lease confirmed dead at provider). Spheron returns
 *      `'gone'` from getHealth for: API 404, native status `terminated` /
 *      `terminated-provider` / `failed`, AND DB-side terminal
 *      (`FAILED`, `PERMANENTLY_FAILED`) — mirroring the Phala fix in
 *      Phase 49b loophole 1. `'unhealthy'` is reserved for "VM running
 *      but containers crashed" and is NEVER a sweeper-close signal.
 *
 * Status mapping (Spheron native → ProviderStatus):
 *   CREATING            → 'creating'
 *   STARTING            → 'starting'
 *   ACTIVE              → 'active'
 *   FAILED              → 'failed'
 *   STOPPED             → 'stopped'
 *   DELETED             → 'deleted'
 *   PERMANENTLY_FAILED  → 'failed'
 */

import type { PrismaClient } from '@prisma/client'
import type {
  DeploymentProvider,
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
import { getSpheronOrchestrator } from '../spheron/orchestrator.js'
import { SpheronApiError, getSpheronClient } from '../spheron/client.js'
import { processFinalSpheronBilling } from '../billing/deploymentSettlement.js'
import { opsAlert } from '../../lib/opsAlert.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-provider')

const SPHERON_STATUS_MAP: Record<string, ProviderStatus> = {
  CREATING: 'creating',
  STARTING: 'starting',
  ACTIVE: 'active',
  FAILED: 'failed',
  STOPPED: 'stopped',
  DELETED: 'deleted',
  PERMANENTLY_FAILED: 'failed',
}

function mapStatus(nativeStatus: string): ProviderStatus {
  return SPHERON_STATUS_MAP[nativeStatus] ?? 'failed'
}

// Native Spheron statuses that mean the VM is intentionally gone — the
// sweeper's `close_gone` path should run regardless of whether a queryable
// row still exists upstream. `terminated-provider` is the SPOT-reclaim
// signal (reserved for v2; flagged early so the schema bit is in place).
const SPHERON_GONE_NATIVE_STATUSES = new Set<string>([
  'terminated',
  'terminated-provider',
  'failed',
])

export class SpheronProvider implements DeploymentProvider {
  readonly name = 'spheron'
  readonly displayName = 'Spheron'

  constructor(private prisma: PrismaClient) {}

  isAvailable(): boolean {
    return !!process.env.SPHERON_API_KEY
  }

  async getActiveDeploymentIds(): Promise<string[]> {
    const active = await this.prisma.spheronDeployment.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
    return active.map(d => d.id)
  }

  /**
   * The DeploymentProvider.deploy entry point. Today the resolver path
   * routes through `templates.ts` (Phase C) which calls
   * `orchestrator.deployServiceSpheron` directly with the full set of
   * Spheron-specific opts (offerId, gpuType, region, instanceType, etc.).
   *
   * The generic `deploy(serviceId, options)` shape can't carry the
   * Spheron offer selection, so this method intentionally throws — Phase C
   * resolvers MUST use `deployFromTemplateToSpheron` / direct
   * orchestrator calls. Mirrors the Phala adapter's runtime guard
   * (`if (!options.composeContent) throw…`) but harder: the contract is
   * "use the typed entry point".
   */
  async deploy(_serviceId: string, _options: DeployOptions): Promise<DeploymentResult> {
    throw new Error(
      'SpheronProvider.deploy(serviceId, options) is not supported — ' +
      'Spheron deploys require typed offer selection (offerId, gpuType, region, etc.). ' +
      'Use the resolvers/templates entry points which call ' +
      'getSpheronOrchestrator(prisma).deployServiceSpheron(serviceId, opts) directly.'
    )
  }

  async stop(_deploymentId: string): Promise<void> {
    throw new Error(
      'Spheron does not support stop — the upstream API only exposes ' +
      'deploy + DELETE. Use close() to permanently delete the VM. ' +
      'Threshold-based low-balance pause re-deploys from savedCloudInit ' +
      'on resume.'
    )
  }

  async close(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)
    if (deployment.status === 'DELETED') return

    const deletedAt = new Date()

    // Phase 31 contract — settle ALL outstanding billing BEFORE the
    // upstream DELETE. If the local row was ACTIVE, the hourly accrual
    // has been ticking and the user owes a final prorated chunk.
    if (deployment.status === 'ACTIVE') {
      await processFinalSpheronBilling(
        this.prisma,
        deploymentId,
        deletedAt,
        'spheron_provider_close'
      )
    }

    // Spheron enforces a 20-minute server-side minimum runtime. If close()
    // runs inside the floor window, DELETE returns 400 with
    // {canTerminate:false, timeRemaining:N}. We mark the local row DELETED
    // (settled, hidden from user) but leave upstreamDeletedAt=null so the
    // staleDeploymentSweeper retries DELETE every 5 minutes until it sticks
    // (or isAlreadyGone). Phase B billing math charges max(actual, 20)
    // minutes so what we paid Spheron matches what we charged the user.
    let upstreamDeletedAt: Date | null = null
    let minimumRuntimeDeferral: { timeRemainingMinutes: number } | null = null

    if (deployment.providerDeploymentId) {
      const orchestrator = getSpheronOrchestrator(this.prisma)
      try {
        await orchestrator.closeDeployment(deployment.providerDeploymentId)
        upstreamDeletedAt = new Date()
      } catch (err) {
        if (err instanceof SpheronApiError) {
          // orchestrator.closeDeployment already swallows isAlreadyGone(),
          // but be defensive: a 404 here means upstream is gone — same as success.
          if (err.isAlreadyGone()) {
            upstreamDeletedAt = new Date()
          } else {
            const min = err.isMinimumRuntimeNotMet()
            if (min) {
              minimumRuntimeDeferral = min
              log.warn(
                {
                  providerDeploymentId: deployment.providerDeploymentId,
                  timeRemainingMinutes: min.timeRemainingMinutes,
                },
                'Spheron DELETE deferred — minimum runtime not met; sweeper will retry'
              )
              // Fire-and-forget — opsAlert never throws, but be defensive.
              opsAlert({
                key: `spheron-delete-deferred:${deployment.providerDeploymentId}`,
                severity: 'warning',
                title: 'Spheron DELETE deferred (minimum runtime)',
                message:
                  `Local row marked DELETED + billing settled, but upstream VM ` +
                  `${deployment.providerDeploymentId} cannot be DELETE'd for ` +
                  `${min.timeRemainingMinutes} more minute(s). Sweeper will retry.`,
                context: {
                  spheronDeploymentId: deployment.providerDeploymentId,
                  localDeploymentId: deploymentId,
                  timeRemainingMinutes: String(min.timeRemainingMinutes),
                },
                suppressMs: 30 * 60 * 1000,
              }).catch(() => undefined)
            } else {
              log.error(
                { providerDeploymentId: deployment.providerDeploymentId, err },
                'Spheron DELETE failed with non-recoverable upstream error'
              )
              throw err
            }
          }
        } else {
          throw err
        }
      }
    } else {
      // No upstream id — treat as already-clean.
      upstreamDeletedAt = new Date()
    }

    await this.prisma.spheronDeployment.update({
      where: { id: deploymentId },
      data: {
        status: 'DELETED',
        // Only stamp upstreamDeletedAt when we actually confirmed cleanup;
        // null leaves the row visible to the sweeper retry pass.
        ...(upstreamDeletedAt ? { upstreamDeletedAt } : {}),
      },
    })

    if (deployment.policyId) {
      await this.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: deletedAt },
      })
    }

    // Re-throwing minimum-runtime would force the resolver/sweeper to
    // treat close() as failed when it actually succeeded locally. Swallow
    // and let the sweeper finish the upstream cleanup. The opsAlert above
    // gives operators visibility.
    if (minimumRuntimeDeferral) return
  }

  /**
   * Phase 31 / 49 / 49b — the most contract-sensitive method.
   *
   * Verdict matrix:
   *   DB DELETED                         → 'unknown' (already settled — sweeper must NOT act)
   *   DB FAILED / PERMANENTLY_FAILED     → 'gone' (sweeper close_gone path syncs row)
   *   DB CREATING / STARTING             → 'starting'
   *   DB STOPPED                         → 'unknown'
   *   DB ACTIVE + no providerDeploymentId → 'unknown' (race during DEPLOY_VM)
   *   DB ACTIVE + API 404                → 'gone'
   *   DB ACTIVE + API status=terminated/terminated-provider/failed → 'gone'
   *   DB ACTIVE + API status=deploying   → 'starting'
   *   DB ACTIVE + API status=running:
   *     SSH null (network blip)          → 'unknown'
   *     SSH ok, no containers            → 'starting' (compose still coming up)
   *     SSH ok, all running              → 'healthy'
   *     SSH ok, some crashed             → 'unhealthy' (NOT a sweeper-close signal)
   *   DB ACTIVE + transient API error    → probe upstream; 'gone' on confirmed 404, else 'unknown'
   *
   * NEVER returns `'healthy'` on catch / transient — that's the original
   * Phase 31 bug that masked dead Phala CVMs from the reconciler.
   */
  async getHealth(deploymentId: string): Promise<DeploymentHealthResult | null> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) return null

    const baseUris = deployment.ipAddress
      ? [`ssh://${deployment.sshUser ?? 'ubuntu'}@${deployment.ipAddress}:${deployment.sshPort ?? 22}`]
      : []

    // Terminal states.
    const terminalStates = new Set(['DELETED', 'FAILED', 'PERMANENTLY_FAILED'])
    if (terminalStates.has(deployment.status)) {
      // DELETED → 'unknown' (already settled; active-set filter excludes
      // DELETED rows anyway). FAILED / PERMANENTLY_FAILED → 'gone' so the
      // sweeper's close_gone path can sync to CLOSED if it ever ends up
      // in the active set. Mirrors the Phase 49b Phala/Akash terminal
      // mapping.
      return {
        provider: 'spheron',
        overall: deployment.status === 'DELETED' ? 'unknown' : 'gone',
        containers: [{
          name: deployment.name,
          status: 'error' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
          message: deployment.errorMessage ?? undefined,
        }],
        lastChecked: new Date(),
      }
    }

    if (deployment.status === 'CREATING' || deployment.status === 'STARTING') {
      return {
        provider: 'spheron',
        overall: 'starting',
        containers: [{
          name: deployment.name,
          status: 'starting' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
        }],
        lastChecked: new Date(),
      }
    }

    if (deployment.status === 'STOPPED') {
      return {
        provider: 'spheron',
        overall: 'unknown',
        containers: [{
          name: deployment.name,
          status: 'unknown' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
        }],
        lastChecked: new Date(),
      }
    }

    // Race window: DEPLOY_VM persisted CREATING but the API POST hasn't
    // returned yet (or the worker crashed between POST success and
    // providerDeploymentId persistence). The stale-deployment sweeper's
    // 25-min CREATING threshold catches this case; meanwhile we report
    // 'unknown' so nothing else acts.
    if (!deployment.providerDeploymentId) {
      return {
        provider: 'spheron',
        overall: 'unknown',
        containers: [{
          name: deployment.name,
          status: 'unknown' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
          message: 'providerDeploymentId not yet persisted',
        }],
        lastChecked: new Date(),
      }
    }

    const orchestrator = getSpheronOrchestrator(this.prisma)
    const upstreamId = deployment.providerDeploymentId

    try {
      const upstream = await orchestrator.getDeploymentStatus(upstreamId)

      // Transient API failure — getDeploymentStatus already logged.
      // Phase 49b: try the existence probe to upgrade 'unknown' → 'gone'
      // when we have evidence the VM is really deleted.
      if (upstream === null) {
        const probe = await orchestrator.probeDeploymentExistence(upstreamId)
        if (probe === 'gone') {
          return {
            provider: 'spheron',
            overall: 'gone',
            containers: [{
              name: deployment.name,
              status: 'error' as ContainerStatus,
              ready: false,
              total: 1,
              available: 0,
              uris: baseUris,
              message: 'VM not found at provider — likely deleted out-of-band',
            }],
            lastChecked: new Date(),
          }
        }
        return {
          provider: 'spheron',
          overall: 'unknown',
          containers: [{
            name: deployment.name,
            status: 'unknown' as ContainerStatus,
            ready: false,
            total: 1,
            available: 0,
            uris: baseUris,
          }],
          lastChecked: new Date(),
        }
      }

      // The VM is intentionally gone (terminated by user / provider /
      // crashed). Sweeper close_gone syncs the DB row to DELETED.
      if (SPHERON_GONE_NATIVE_STATUSES.has(upstream.status)) {
        return {
          provider: 'spheron',
          overall: 'gone',
          containers: [{
            name: deployment.name,
            status: 'error' as ContainerStatus,
            ready: false,
            total: 1,
            available: 0,
            uris: baseUris,
            message: `Spheron upstream status=${upstream.status}`,
          }],
          lastChecked: new Date(),
        }
      }

      if (upstream.status === 'deploying') {
        return {
          provider: 'spheron',
          overall: 'starting',
          containers: [{
            name: deployment.name,
            status: 'starting' as ContainerStatus,
            ready: false,
            total: 1,
            available: 0,
            uris: baseUris,
          }],
          lastChecked: new Date(),
        }
      }

      // upstream.status === 'running' — VM up, check container health
      // over SSH. We need the ACTIVE row to have an ipAddress; if it
      // doesn't (race during ipAddress persistence), report 'starting'
      // so the next tick re-checks.
      if (upstream.status === 'running') {
        if (!deployment.ipAddress) {
          return {
            provider: 'spheron',
            overall: 'starting',
            containers: [{
              name: deployment.name,
              status: 'starting' as ContainerStatus,
              ready: false,
              total: 1,
              available: 0,
              uris: baseUris,
              message: 'VM is running upstream but ipAddress not yet persisted locally',
            }],
            lastChecked: new Date(),
          }
        }

        const docker = await orchestrator.getDockerHealthViaSsh({
          ipAddress: deployment.ipAddress,
          sshUser: deployment.sshUser ?? 'ubuntu',
          sshPort: deployment.sshPort ?? 22,
        })

        // SSH transient (network, key issue, sshd restarting). NEVER fake
        // 'healthy' on a SSH error — return 'unknown' so the sweeper waits.
        if (docker === null) {
          return {
            provider: 'spheron',
            overall: 'unknown',
            containers: [{
              name: deployment.name,
              status: 'unknown' as ContainerStatus,
              ready: false,
              total: 1,
              available: 0,
              uris: baseUris,
              message: 'SSH probe transiently failed',
            }],
            lastChecked: new Date(),
          }
        }

        // No containers running. Two cases:
        //   - Compose still coming up (apt install + image pull) → 'starting'
        //   - Compose finished and crashed out → 'unhealthy'
        // We can't distinguish reliably from `docker ps` alone (no
        // `docker ps -a` parsing yet — Phase B may add it). Most workloads
        // restart-policy=on-failure, so an empty `docker ps` after some
        // grace period implies failure. For now we report 'unhealthy' if
        // the deployment has been ACTIVE > 10 min and 'starting' otherwise.
        if (docker.containers.length === 0) {
          const ageMs = deployment.activeStartedAt
            ? Date.now() - deployment.activeStartedAt.getTime()
            : 0
          const overall: OverallHealth = ageMs > 10 * 60 * 1000 ? 'unhealthy' : 'starting'
          return {
            provider: 'spheron',
            overall,
            containers: [{
              name: deployment.name,
              status: overall === 'unhealthy' ? 'crashed' : 'starting',
              ready: false,
              total: 1,
              available: 0,
              uris: baseUris,
              message: docker.warning ?? undefined,
            }],
            lastChecked: new Date(),
          }
        }

        const containers: ContainerHealth[] = docker.containers.map(c => ({
          name: c.name,
          status: (c.state === 'running' ? 'running' : 'crashed') as ContainerStatus,
          ready: c.state === 'running',
          total: 1,
          available: c.state === 'running' ? 1 : 0,
          uris: baseUris,
          message: c.status,
        }))

        return {
          provider: 'spheron',
          overall: docker.allRunning ? 'healthy' : 'unhealthy',
          containers,
          lastChecked: new Date(),
        }
      }

      // Unknown native status string — Spheron added a new value we don't
      // recognise. Stay 'unknown' so the sweeper doesn't act.
      return {
        provider: 'spheron',
        overall: 'unknown',
        containers: [{
          name: deployment.name,
          status: 'unknown' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
          message: `Unrecognised Spheron status: ${upstream.status}`,
        }],
        lastChecked: new Date(),
      }
    } catch (err) {
      // 404 → 'gone' directly (we have evidence). Anything else → use
      // the existence probe to distinguish gone vs transient.
      if (err instanceof SpheronApiError && err.status === 404) {
        return {
          provider: 'spheron',
          overall: 'gone',
          containers: [{
            name: deployment.name,
            status: 'error' as ContainerStatus,
            ready: false,
            total: 1,
            available: 0,
            uris: baseUris,
            message: 'Spheron API returned 404',
          }],
          lastChecked: new Date(),
        }
      }

      try {
        const probe = await orchestrator.probeDeploymentExistence(upstreamId)
        if (probe === 'gone') {
          return {
            provider: 'spheron',
            overall: 'gone',
            containers: [{
              name: deployment.name,
              status: 'error' as ContainerStatus,
              ready: false,
              total: 1,
              available: 0,
              uris: baseUris,
              message: 'Existence probe confirmed VM is gone',
            }],
            lastChecked: new Date(),
          }
        }
      } catch {
        // Probe itself failed — fall through to 'unknown'.
      }

      log.warn({ deploymentId, err }, 'Spheron getHealth caught error — returning unknown')
      return {
        provider: 'spheron',
        overall: 'unknown',
        containers: [{
          name: deployment.name,
          status: 'unknown' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: baseUris,
        }],
        lastChecked: new Date(),
      }
    }
  }

  async getStatus(deploymentId: string): Promise<DeploymentStatusResult> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)

    let upstreamStatus: unknown = null
    if (deployment.providerDeploymentId) {
      const orchestrator = getSpheronOrchestrator(this.prisma)
      try {
        upstreamStatus = await orchestrator.getDeploymentStatus(deployment.providerDeploymentId)
      } catch (err) {
        // Surface API errors via metadata; status mapping still uses local
        // DB state. Don't throw — `getStatus` is a read.
        log.warn({ deploymentId, err }, 'Spheron getStatus upstream lookup failed')
      }
    }

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.ipAddress) {
      serviceUrls.ssh = [`ssh://${deployment.sshUser ?? 'ubuntu'}@${deployment.ipAddress}:${deployment.sshPort ?? 22}`]
    }

    return {
      status: mapStatus(deployment.status),
      nativeStatus: deployment.status,
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      metadata: {
        providerDeploymentId: deployment.providerDeploymentId,
        upstreamProvider: deployment.provider,
        offerId: deployment.offerId,
        gpuType: deployment.gpuType,
        gpuCount: deployment.gpuCount,
        region: deployment.region,
        operatingSystem: deployment.operatingSystem,
        instanceType: deployment.instanceType,
        ipAddress: deployment.ipAddress,
        sshUser: deployment.sshUser,
        sshPort: deployment.sshPort,
        hourlyRateCents: deployment.hourlyRateCents,
        totalBilledCents: deployment.totalBilledCents,
        upstreamLiveStatus: upstreamStatus,
      },
    }
  }

  async getLogs(deploymentId: string, opts?: LogOptions): Promise<string> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)
    if (!deployment.ipAddress) {
      throw new Error('Spheron deployment has no ipAddress yet — VM may still be provisioning')
    }

    const orchestrator = getSpheronOrchestrator(this.prisma)
    return orchestrator.getLogsViaSsh(
      {
        ipAddress: deployment.ipAddress,
        sshUser: deployment.sshUser ?? 'ubuntu',
        sshPort: deployment.sshPort ?? 22,
      },
      opts
    )
  }

  async streamLogs(deploymentId: string, opts?: LogStreamOptions): Promise<LogStream> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)
    if (!deployment.ipAddress) {
      throw new Error('Spheron deployment has no ipAddress yet — VM may still be provisioning')
    }
    if (deployment.status !== 'ACTIVE') {
      throw new Error(`Spheron deployment is not active (status: ${deployment.status})`)
    }

    const orchestrator = getSpheronOrchestrator(this.prisma)
    return orchestrator.streamLogsViaSsh(
      {
        ipAddress: deployment.ipAddress,
        sshUser: deployment.sshUser ?? 'ubuntu',
        sshPort: deployment.sshPort ?? 22,
      },
      opts
    )
  }

  async getShell(deploymentId: string, opts?: ShellOptions): Promise<ShellSession> {
    const deployment = await this.prisma.spheronDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Spheron deployment not found: ${deploymentId}`)
    if (deployment.status !== 'ACTIVE') {
      throw new Error(`Spheron deployment is not active (status: ${deployment.status})`)
    }
    if (!deployment.ipAddress) {
      throw new Error('Spheron deployment has no ipAddress yet — VM may still be provisioning')
    }

    const orchestrator = getSpheronOrchestrator(this.prisma)
    return orchestrator.getShell(
      {
        ipAddress: deployment.ipAddress,
        sshUser: deployment.sshUser ?? 'ubuntu',
        sshPort: deployment.sshPort ?? 22,
      },
      opts
    )
  }

  getCapabilities(): ProviderCapabilities {
    return {
      // Spheron only supports deploy + DELETE — matches Akash, NOT Phala.
      supportsStop: false,
      // SSH-tunneled `docker logs --follow` (services/spheron/orchestrator.streamLogsViaSsh).
      supportsLogStreaming: true,
      supportsTEE: false,
      // Volumes API exists upstream but is deferred to Phase 2.
      supportsPersistentStorage: true,
      supportsWebSocket: true,
      supportsShell: true,
      // cloudInit doesn't fit 'sdl' / 'compose' / 'manifest' — use 'custom'.
      configFormat: 'custom',
      billingModel: 'hourly',
    }
  }
}

export function createSpheronProvider(prisma: PrismaClient): SpheronProvider {
  return new SpheronProvider(prisma)
}

// Re-export so callers can probe configuration without importing the client
// module directly. Mirrors the akashProvider's `startHealthPrewarmer` export
// pattern (a side-helper that lives near the adapter for discoverability).
export function isSpheronConfigured(): boolean {
  return getSpheronClient() !== null
}
