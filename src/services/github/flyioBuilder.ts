/**
 * Fly.io Machines API client — alternative build executor.
 *
 * Replaces the in-cluster `af-builder` Kubernetes Job with an ephemeral
 * Fly Machine for each push. Same `build.sh` contract; same callback
 * payload; same BuildJob lifecycle. The dispatch happens in
 * `buildSpawner.ts` based on the `BUILD_EXECUTOR` env switch.
 *
 * Why Fly?
 *   - Pay-per-second billing → a 60s build costs ~$0.001 instead of
 *     reserving a 4Gi/2vCPU pod slot in our cluster all month.
 *   - Firecracker microVMs → real kernel, dockerd just works without
 *     `--privileged` or a dind sidecar. One image, one process tree.
 *   - `auto_destroy: true` → machine reaps itself the second the
 *     script exits. Zero cleanup logic on our side.
 *   - Hard isolation → a runaway build can't OOM `service-cloud-api`,
 *     can't starve other tenants, can't write to our PVCs.
 *
 * Failure mode:
 *   - If the Machines API returns 5xx, throw. `buildSpawner` will fall
 *     back to the K8s Job path so a Fly outage never blocks builds
 *     during the cutover window.
 *
 * The image referenced by `FLY_BUILDER_IMAGE` MUST be public on GHCR
 * (or accompanied by Fly registry creds in `config.image_credentials`).
 * We default to public; see infra/ for the GHCR visibility setup.
 */

import { createLogger } from '../../lib/logger.js'

const log = createLogger('github.flyioBuilder')

const FLY_API_BASE = process.env.FLY_API_BASE || 'https://api.machines.dev/v1'
const FLY_TIMEOUT_MS = Number(process.env.FLY_API_TIMEOUT_MS || 30_000)

export interface FlyMachineEnv {
  [key: string]: string
}

export interface FlySpawnInput {
  /** Stable, human-readable machine name (we use `build-<jobId>`). */
  name: string
  /** Env vars handed to the entrypoint. Same as the K8s Job template. */
  env: FlyMachineEnv
}

export interface FlySpawnResult {
  /** Fly Machine id, e.g. `91851edb1e6783`. Stored in BuildJob.k8sJobName
   *  prefixed with `fly:` so `deleteBuildJob` can route correctly. */
  machineId: string
  /** Human-readable name we asked Fly to assign. */
  name: string
  /** Region the machine was actually placed in. */
  region: string
}

/** Strongly-typed view of the bits of the Fly API response we read. */
interface FlyMachineResponse {
  id: string
  name: string
  region: string
  state: string
}

interface FlyConfig {
  app: string
  region: string
  image: string
  cpuKind: 'shared' | 'performance'
  cpus: number
  memoryMb: number
  apiToken: string
}

function getFlyConfig(): FlyConfig {
  const apiToken = process.env.FLY_API_TOKEN || ''
  const app = process.env.FLY_BUILDER_APP || ''
  if (!apiToken) throw new Error('FLY_API_TOKEN is not set')
  if (!app) throw new Error('FLY_BUILDER_APP is not set')

  return {
    apiToken,
    app,
    region: process.env.FLY_BUILDER_REGION || 'ord',
    image: process.env.FLY_BUILDER_IMAGE || 'ghcr.io/alternatefutures/af-builder:fly-latest',
    cpuKind: (process.env.FLY_BUILDER_CPU_KIND as 'shared' | 'performance') || 'performance',
    cpus: Number(process.env.FLY_BUILDER_CPUS || 2),
    memoryMb: Number(process.env.FLY_BUILDER_MEMORY_MB || 4096),
  }
}

async function flyFetch<T>(
  cfg: FlyConfig,
  pathSuffix: string,
  init: RequestInit & { method: 'GET' | 'POST' | 'DELETE' },
): Promise<T> {
  const url = `${FLY_API_BASE}/apps/${encodeURIComponent(cfg.app)}${pathSuffix}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FLY_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      throw new Error(`Fly API ${init.method} ${pathSuffix} failed: ${res.status} ${body}`)
    }
    // DELETE returns 200 with `{ ok: true }`, GET/POST return JSON; both safe to parse.
    if (res.status === 204) return undefined as unknown as T
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Spawn a one-shot Fly Machine that runs the builder image and exits.
 * The machine self-destructs on exit (`auto_destroy: true`), so there
 * is nothing to clean up unless the caller explicitly cancels.
 */
export async function spawnFlyBuilder(input: FlySpawnInput): Promise<FlySpawnResult> {
  const cfg = getFlyConfig()

  const body = {
    name: input.name,
    region: cfg.region,
    config: {
      image: cfg.image,
      auto_destroy: true,
      restart: { policy: 'no' as const },
      guest: {
        cpu_kind: cfg.cpuKind,
        cpus: cfg.cpus,
        memory_mb: cfg.memoryMb,
      },
      env: input.env,
    },
  }

  const machine = await flyFetch<FlyMachineResponse>(cfg, '/machines', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  log.info(
    { machineId: machine.id, name: machine.name, region: machine.region, state: machine.state },
    'Fly builder machine created',
  )

  return { machineId: machine.id, name: machine.name, region: machine.region }
}

/**
 * Force-destroy a Fly Machine. Idempotent — a 404 (already gone) is
 * treated as success. Used on user-initiated cancel; happy-path teardown
 * is handled by `auto_destroy: true`.
 */
export async function destroyFlyMachine(machineId: string): Promise<void> {
  const cfg = getFlyConfig()
  try {
    await flyFetch<unknown>(cfg, `/machines/${encodeURIComponent(machineId)}?force=true`, {
      method: 'DELETE',
    })
    log.info({ machineId }, 'Fly machine destroyed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes(' 404 ')) {
      log.info({ machineId }, 'Fly machine already gone (404)')
      return
    }
    log.warn({ err, machineId }, 'failed to destroy Fly machine')
  }
}
