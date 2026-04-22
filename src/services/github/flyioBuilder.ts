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

/**
 * Parse an integer env var with bounds + a fallback. Crucially we reject
 * NaN (e.g. `Number('4gb')` → NaN silently passed to Fly's API, which
 * then returns a cryptic 400) and clamp out-of-range values so a typo
 * like `FLY_BUILDER_CPUS=99999` doesn't try to rent a machine Fly won't
 * sell us. Returns `fallback` on any invalid input and logs a warning
 * so the operator can fix the configmap instead of silently running
 * with a surprise default.
 */
function parseEnvInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts: { min: number; max: number },
): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    log.warn({ name, raw, fallback }, 'env var not a valid integer — using fallback')
    return fallback
  }
  if (parsed < opts.min || parsed > opts.max) {
    log.warn(
      { name, raw, parsed, min: opts.min, max: opts.max, fallback },
      'env var out of allowed range — using fallback',
    )
    return fallback
  }
  return parsed
}

const FLY_TIMEOUT_MS = parseEnvInt('FLY_API_TIMEOUT_MS', process.env.FLY_API_TIMEOUT_MS, 30_000, {
  min: 1_000,
  max: 300_000,
})

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
  /**
   * Fly Volume ids (e.g. `vol_42kg90p00e8ywj14`) that back the persistent
   * buildkit/dockerd state. Set via FLY_BUILDER_CACHE_VOLUME as a
   * comma-separated list. When non-empty, each spawned machine attaches
   * ONE volume from the pool at `cacheMountPath` and `build-fly.sh`
   * points `dockerd --data-root` into a subdir of that mount. Result:
   * base images, cache mounts (pnpm/pip/cargo stores), and buildkit
   * snapshotter state all survive machine reaping.
   *
   * Fly Volumes are single-attach. We spawn machines with `auto_destroy:
   * true`, so the previous machine's volume detaches when it exits —
   * but there's a small window where the new machine's POST /machines
   * returns 409 "volume in use." With multiple volumes we pick a random
   * one first, then rotate through the list on each 409 retry so N
   * concurrent builds proceed fully warm instead of serializing on one
   * volume and mostly falling back to ephemeral.
   *
   * Leaving this unset (empty list) falls back to ephemeral state
   * (slow but works).
   */
  cacheVolumeIds: string[]
  cacheMountPath: string
  /**
   * Hard cap on how long `build-fly.sh` lets `/app/build.sh` run before
   * SIGTERM + SIGKILL. Passed into the machine as AF_BUILD_TIMEOUT_SECONDS
   * so the timeout wrapper lives in the builder image (closer to the
   * actual process tree) rather than polling Fly from here. A 15-min cap
   * means a runaway build costs at most ~$0.09 instead of the $0.11+
   * zombies we saw in §5 of HANDOFF.md.
   */
  maxRuntimeSeconds: number
}

/**
 * Fly Volume IDs have a fixed shape: `vol_` followed by 12–24 alphanumeric
 * characters (they're k-sortable base62 identifiers from Fly's side).
 * Accepting any non-empty string here means a configmap typo (`vol-abc`
 * with a hyphen, a stray quote, an Akash lease dseq pasted in) lands in
 * the POST /machines request body where Fly rejects it with a generic
 * 422 "invalid input" — easy to miss when chasing a build failure.
 * Validating at parse time means the bad entry never joins the pool and
 * we log it exactly once with the env var name.
 */
const FLY_VOLUME_ID_PATTERN = /^vol_[a-zA-Z0-9]{6,32}$/

function parseVolumeList(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const segment of raw.split(',')) {
    const id = segment.trim()
    if (id.length === 0) continue
    if (!FLY_VOLUME_ID_PATTERN.test(id)) {
      log.warn(
        { invalidVolumeId: id },
        'FLY_BUILDER_CACHE_VOLUME contains an entry that does not match vol_<alnum> — ignoring',
      )
      continue
    }
    out.push(id)
  }
  return out
}

/**
 * Validate the CPU-kind env input against Fly's fixed enum instead of
 * casting blindly. A typo ("perfromance") previously produced a
 * `cpu_kind: "perfromance"` request that Fly rejects with a 400 at
 * spawn time — minutes after the pod started. Validating at config
 * load means the service either boots with a known-good value or
 * logs one warning and falls back to `performance`.
 */
const VALID_CPU_KINDS = ['shared', 'performance'] as const
type CpuKind = (typeof VALID_CPU_KINDS)[number]

function parseCpuKind(raw: string | undefined, fallback: CpuKind): CpuKind {
  if (raw === undefined || raw === '') return fallback
  if ((VALID_CPU_KINDS as readonly string[]).includes(raw)) return raw as CpuKind
  log.warn(
    { raw, allowed: VALID_CPU_KINDS, fallback },
    'FLY_BUILDER_CPU_KIND is not a recognised Fly enum — using fallback',
  )
  return fallback
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
    cpuKind: parseCpuKind(process.env.FLY_BUILDER_CPU_KIND, 'performance'),
    cpus: parseEnvInt('FLY_BUILDER_CPUS', process.env.FLY_BUILDER_CPUS, 2, { min: 1, max: 16 }),
    memoryMb: parseEnvInt('FLY_BUILDER_MEMORY_MB', process.env.FLY_BUILDER_MEMORY_MB, 4096, {
      min: 256,
      max: 65_536,
    }),
    cacheVolumeIds: parseVolumeList(process.env.FLY_BUILDER_CACHE_VOLUME),
    cacheMountPath: process.env.FLY_BUILDER_CACHE_MOUNT || '/var/lib/af-cache',
    maxRuntimeSeconds: parseEnvInt(
      'FLY_BUILDER_MAX_RUNTIME_SECONDS',
      process.env.FLY_BUILDER_MAX_RUNTIME_SECONDS,
      900,
      { min: 60, max: 14_400 },
    ),
  }
}

/** Exported for testability — see flyioBuilder.test.ts. */
export const __test__ = { parseVolumeList, parseCpuKind, parseEnvInt, redactFlyErrorBody }

/**
 * Strip anything that looks like a bearer token or long hex secret out
 * of a Fly error body before it's embedded in an Error.message that
 * may end up in Sentry, logs, or downstream webhook payloads. The body
 * is also truncated to keep log lines bounded. We also collapse the
 * request body we posted (machine config) out of echo-back fields,
 * since `env:` contains things like GITHUB_APP_PRIVATE_KEY values that
 * should NEVER round-trip through an exception message.
 */
export function redactFlyErrorBody(body: string): string {
  if (!body) return ''
  const MAX = 400
  let out = body
    // bearer-ish tokens / API keys
    .replace(/(Bearer\s+|fo[a-z]*_)[A-Za-z0-9_\-.]{16,}/gi, '$1[REDACTED]')
    // base64-shaped secrets ≥ 40 chars (matches RSA keys, tokens)
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[REDACTED]')
    // JSON env blobs the server echoes back on 422 — scrub the whole
    // value side of any `"env": { ... }` to avoid leaking per-job secrets.
    .replace(/"env"\s*:\s*\{[^}]*\}/g, '"env":"[REDACTED]"')
  if (out.length > MAX) out = `${out.slice(0, MAX)}…(truncated ${out.length - MAX} chars)`
  return out
}

/**
 * Returns parsed JSON for 2xx-with-body responses, or `undefined` for
 * 204 No Content. Callers that depend on a body should narrow with a
 * runtime check rather than assuming non-null.
 *
 * Errors throw with a *redacted* + truncated body — the full body is
 * only emitted through the structured logger where we can scope it
 * (and rely on pino's redact config in prod).
 */
async function flyFetch<T>(
  cfg: FlyConfig,
  pathSuffix: string,
  init: RequestInit & { method: 'GET' | 'POST' | 'DELETE' },
): Promise<T | undefined> {
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
      log.warn(
        { status: res.status, method: init.method, pathSuffix, bodyLen: body.length },
        'Fly API non-2xx response',
      )
      throw new Error(
        `Fly API ${init.method} ${pathSuffix} failed: ${res.status} ${redactFlyErrorBody(body)}`,
      )
    }
    // DELETE returns 200 with `{ ok: true }`, GET/POST return JSON; both safe to parse.
    if (res.status === 204) return undefined
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Spawn a one-shot Fly Machine that runs the builder image and exits.
 * The machine self-destructs on exit (`auto_destroy: true`), so there
 * is nothing to clean up unless the caller explicitly cancels.
 *
 * If `FLY_BUILDER_CACHE_VOLUME` is set (comma-separated volume id list),
 * one volume from the pool is attached at `cacheMountPath` so the
 * builder can reuse dockerd + buildkit state across machines. Fly
 * Volumes are single-attach; on a 409 "volume busy" we rotate through
 * the pool on each retry so N concurrent builds land on distinct
 * volumes instead of serializing on one.
 *
 * If `FLY_BUILDER_MAX_RUNTIME_SECONDS` is set (default 900), the spawner
 * passes the cap through as `AF_BUILD_TIMEOUT_SECONDS` in the machine's
 * env; `build-fly.sh` enforces it via the `timeout(1)` command so a
 * runaway build is killed and the Fly machine auto-destroys on exit —
 * capping the worst-case cost per build.
 */
export async function spawnFlyBuilder(input: FlySpawnInput): Promise<FlySpawnResult> {
  const cfg = getFlyConfig()

  // Randomize starting volume so concurrent spawns from different
  // API replicas (or webhooks firing in quick succession) don't all
  // pick pool[0] and collide. Each retry then rotates by +1 in the
  // pool so we deterministically sweep every slot before giving up.
  const poolSize = cfg.cacheVolumeIds.length
  const startIndex = poolSize > 0 ? Math.floor(Math.random() * poolSize) : 0

  // Volume-attach race. If the previous builder machine is still in
  // `destroying`/`destroyed` state, its volume attachment lingers for
  // a few seconds. Base backoff: 2,4,8,16,30s, each scaled by a random
  // [0.75, 1.25] jitter factor so concurrent pushes don't synchronize
  // their retries. With a multi-volume pool we also rotate the chosen
  // volume on each attempt, so attempt=0 may succeed immediately on a
  // free slot even if pool[startIndex] was busy.
  //
  // Total attempts = initial + baseDelays.length retries = 6.
  // The old loop used `<= baseDelays.length` with an inline
  // `attempt < baseDelays.length` guard inside the catch — correct in
  // practice but one refactor away from `baseDelays[attempt] = undefined`
  // → `setTimeout(r, NaN)` → zero-delay retry storm. Pin the bound
  // explicitly and only index baseDelays when we know we have budget.
  const baseDelays = [2000, 4000, 8000, 16000, 30000]
  const MAX_ATTEMPTS = baseDelays.length + 1
  let lastErr: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const chosenVolume =
      poolSize > 0 ? cfg.cacheVolumeIds[(startIndex + attempt) % poolSize] : null

    const baseConfig: Record<string, unknown> = {
      image: cfg.image,
      auto_destroy: true,
      restart: { policy: 'no' as const },
      guest: {
        cpu_kind: cfg.cpuKind,
        cpus: cfg.cpus,
        memory_mb: cfg.memoryMb,
      },
      env: {
        ...input.env,
        // Echo mount info into the machine env so build-fly.sh doesn't
        // have to probe `/proc/mounts` — keeps the shell side simple
        // and makes the contract obvious: "if AF_CACHE_ROOT is set,
        // dockerd data-root lives there."
        ...(chosenVolume ? { AF_CACHE_ROOT: cfg.cacheMountPath } : {}),
        // Runtime cap enforced inside build-fly.sh via `timeout(1)`.
        // Kept as a string because Fly's API coerces env values to
        // strings anyway.
        AF_BUILD_TIMEOUT_SECONDS: String(cfg.maxRuntimeSeconds),
      },
      ...(chosenVolume
        ? {
            mounts: [
              {
                volume: chosenVolume,
                path: cfg.cacheMountPath,
              },
            ],
          }
        : {}),
    }

    const body = {
      name: input.name,
      region: cfg.region,
      config: baseConfig,
    }

    try {
      const machine = await flyFetch<FlyMachineResponse>(cfg, '/machines', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      // POST /machines always returns a body on success; if it didn't, Fly
      // changed its contract and we have no machine id to track.
      if (!machine) {
        throw new Error('Fly POST /machines returned no body — cannot track machine lifecycle')
      }
      log.info(
        {
          machineId: machine.id,
          name: machine.name,
          region: machine.region,
          state: machine.state,
          volume: chosenVolume,
          volumePoolSize: poolSize,
          maxRuntimeSeconds: cfg.maxRuntimeSeconds,
          attempt,
        },
        'Fly builder machine created',
      )
      return { machineId: machine.id, name: machine.name, region: machine.region }
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const hasRetryBudget = attempt < baseDelays.length
      // Retry only on volume-attach conflicts. When a pool is configured
      // we always have somewhere else to try; rotating the volume choice
      // above usually avoids the backoff wait entirely by the second attempt.
      const isRetryable = poolSize > 0 && (msg.includes('volume') || msg.includes('409'))
      if (!hasRetryBudget || !isRetryable) throw err
      const jitter = 0.75 + Math.random() * 0.5 // [0.75, 1.25]
      const delayMs = Math.round(baseDelays[attempt] * jitter)
      log.warn(
        { attempt, delayMs, err: msg, triedVolume: chosenVolume, poolSize },
        'Fly machine spawn rejected (volume busy) — rotating volume + retrying',
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('spawnFlyBuilder: exhausted retries')
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
