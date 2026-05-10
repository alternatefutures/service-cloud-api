/**
 * Spheron cloud-init builder.
 *
 * Spheron VMs ship as plain Ubuntu — there is no native container orchestration.
 * To run our compose-based templates on them we hand-roll Docker bring-up via
 * cloud-init (`writeFiles` + `runcmd`). This module is the single place that
 * decision lives.
 *
 * Locked decision (per AF_HANDOFF — Spheron Phase A, 2026-04-21 → 2026-05-06):
 *   "Smart-pick: prefer pre-installed Docker, fall back to apt"
 *
 *   - If the chosen `operatingSystem` string clearly indicates Docker is
 *     pre-installed (e.g. data-crunch's `Ubuntu 22.04 + CUDA 13.0 Open + Docker`),
 *     skip the apt install — the docker daemon is ready out of the box.
 *   - Otherwise, list `docker.io` + `docker-compose-v2` + `ca-certificates` in
 *     `packages` and `systemctl enable --now docker` before bringing compose up.
 *
 * Pure transformation. No DB, no HTTP. Returns a typed `SpheronCloudInit`
 * matching `client.ts`'s shape, ready to drop into `POST /api/deployments`.
 *
 * Security:
 *   - The compose YAML lands at /opt/af/docker-compose.yml with mode 0644.
 *   - The .env file lands at /opt/af/.env with mode 0600 (env values may carry
 *     secrets — match the project-wide rule of never logging or world-reading
 *     secrets, see Phase 31 plaintext-env audit and AF_DEVELOPMENT_PROCESS.md
 *     line ~2191).
 *   - Env values containing literal `\n` are rejected — Docker `.env` files are
 *     line-oriented and a newline-bearing value silently corrupts every later
 *     key. Better to fail loudly at deploy time than ship a half-decoded env.
 */

import type { SpheronCloudInit } from './client.js'

export interface BuildCloudInitInput {
  /**
   * Verbatim docker-compose YAML. Optional — when omitted (raw GPU instance
   * use case), the result skips the compose file and just installs Docker as
   * a courtesy so the user can `docker run` on first SSH. Pass undefined for
   * "Spheron VM only — I'll set it up myself".
   */
  composeContent?: string | null

  /**
   * Env vars to drop in /opt/af/.env. Each value must not contain a literal
   * newline. Empty record → an empty .env is still written so docker-compose's
   * `--env-file .env` flag never errors with "missing file".
   */
  envVars?: Record<string, string>

  /**
   * The exact `operatingSystem` string passed to `POST /api/deployments`. Used
   * only to decide pre-installed-Docker vs apt-install path. Case-insensitive
   * substring check against `docker`.
   */
  operatingSystem: string

  /**
   * Optional extra `runcmd` lines appended AFTER docker-compose bring-up
   * (template-specific post-boot setup, smoke probes, etc.). Avoid putting
   * secrets here — `runcmd` is logged in cloud-init's diagnostic output.
   */
  extraRuncmd?: string[]

  /**
   * TCP ports to open through whatever firewall the upstream image ships
   * (UFW on most Ubuntu base images). Spheron VMs only expose port 22 by
   * default; `subdomainProxy` targets `http://<ipAddress>:<containerPort>`
   * so the container port MUST be reachable from outside the VM.
   *
   * Architecture decision (Spheron Phase C, 2026-05-06): Option A —
   * cloudInit runs `ufw allow <port>/tcp || true` for each entry; HTTPS
   * termination is the user's problem (Caddy sidecar deferred to Phase 2).
   * The `|| true` is intentional: not every base image installs UFW
   * (sesterce's `ubuntu22.04_cuda12.8_shade_os` doesn't); we want a noisy
   * cloud-init log line, not a boot failure, when ufw isn't present.
   */
  exposePorts?: number[]
}

const COMPOSE_PATH = '/opt/af/docker-compose.yml'
const ENV_PATH = '/opt/af/.env'

/**
 * Cheap heuristic — is Docker baked into this OS image already?
 *
 * The test is intentionally permissive: any `operatingSystem` string that
 * mentions "docker" (case-insensitive) is treated as preinstalled. False
 * positives produce a redundant `systemctl enable --now docker` (which is a
 * no-op if the daemon is already running) — cheap. False negatives produce
 * a redundant `apt-get install docker.io` — slower but still correct.
 *
 * Confirmed-baked images we rely on (live as of 2026-04-21):
 *   - data-crunch: "Ubuntu 22.04 + CUDA 13.0 Open + Docker"
 *   - data-crunch: "Ubuntu 22.04 + CUDA 12.4 + Docker"
 * Probably-not-baked:
 *   - sesterce: "ubuntu22.04_cuda12.8_shade_os" (custom — no Docker reference)
 *   - voltage-park: "ubuntu-22.04" (vanilla)
 */
export function isDockerPreinstalled(operatingSystem: string): boolean {
  return /\bdocker\b/i.test(operatingSystem)
}

export class CloudInitValidationError extends Error {
  readonly key?: string

  constructor(message: string, key?: string) {
    super(message)
    this.name = 'CloudInitValidationError'
    this.key = key
  }
}

/**
 * Render env vars into the .env file format docker-compose's `--env-file`
 * understands. NOT a shell-escape — values are passed verbatim, exactly as
 * `KEY=value` per line. Newlines in values are not representable in this
 * format and we reject them.
 *
 * Empty record → empty string (single trailing newline) so `--env-file .env`
 * always has a file to read.
 */
export function renderEnvFile(envVars: Record<string, string> | undefined): string {
  if (!envVars || Object.keys(envVars).length === 0) return ''
  const lines: string[] = []
  for (const [key, value] of Object.entries(envVars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CloudInitValidationError(
        `Invalid env var key "${key}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        key,
      )
    }
    if (typeof value !== 'string') {
      throw new CloudInitValidationError(
        `Env var "${key}" must be a string (got ${typeof value})`,
        key,
      )
    }
    if (value.includes('\n') || value.includes('\r')) {
      throw new CloudInitValidationError(
        `Env var "${key}" contains a newline — not supported by docker-compose .env files. ` +
          `Strip the newline or base64-encode the value and decode it inside the container.`,
        key,
      )
    }
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Build the cloudInit payload for `POST /api/deployments`.
 *
 * Mirror this exactly when persisting `SpheronDeployment.savedCloudInit` so
 * resume after low-balance pause replays the same VM state.
 */
export function buildCloudInit(input: BuildCloudInitInput): SpheronCloudInit {
  const preinstalled = isDockerPreinstalled(input.operatingSystem)

  const writeFiles: NonNullable<SpheronCloudInit['writeFiles']> = []

  if (input.composeContent && input.composeContent.trim().length > 0) {
    writeFiles.push({
      path: COMPOSE_PATH,
      content: input.composeContent,
      owner: 'root:root',
      permissions: '0644',
    })
    // Always lay down a .env, even if empty, so `--env-file .env` doesn't
    // fall over with ENOENT inside the runcmd.
    writeFiles.push({
      path: ENV_PATH,
      content: renderEnvFile(input.envVars),
      owner: 'root:root',
      permissions: '0600',
    })
  }

  // Build runcmd in a precise order:
  //   1. (optional) apt install Docker — ONLY when not preinstalled
  //   2. systemctl enable --now docker — idempotent on both branches
  //   3. (optional) ufw allow <port>/tcp — ONLY when exposePorts present
  //   4. (optional) docker compose up -d — ONLY when composeContent present
  //   5. (optional) extraRuncmd — caller-supplied post-bring-up lines
  const runcmd: string[] = []

  if (!preinstalled) {
    // `apt-get update` first so the package index is fresh on the cold image;
    // `-y` to keep the boot non-interactive; redirect stderr to surface in
    // cloud-init's logs without breaking on harmless "delaying package
    // configuration" notices.
    runcmd.push('apt-get update -y')
    runcmd.push('DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 ca-certificates')
  }

  // Idempotent — safe on both preinstalled and apt-installed paths. Quoted to
  // keep cloud-init's YAML parser from interpreting the `--now` flag as a
  // sequence anchor (rare, but cheap insurance).
  runcmd.push('systemctl enable --now docker')

  // Open the firewall for each exposed container port BEFORE bringing up
  // docker-compose so the first inbound request after compose-up doesn't
  // race a still-pending ufw rule. `|| true` so missing-ufw doesn't fail
  // the boot — see exposePorts JSDoc.
  for (const port of input.exposePorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CloudInitValidationError(
        `Invalid exposePorts entry: ${port}. Must be an integer in [1, 65535].`,
      )
    }
    runcmd.push(`ufw allow ${port}/tcp || true`)
  }

  if (input.composeContent && input.composeContent.trim().length > 0) {
    // `--env-file` is required because docker-compose v2 only auto-loads .env
    // from the same dir as the compose file IF the working dir matches; we
    // pass it explicitly so a different cwd at boot doesn't silently drop env.
    runcmd.push('cd /opt/af && docker compose --env-file .env up -d')
  }

  for (const line of input.extraRuncmd ?? []) {
    if (typeof line !== 'string' || line.length === 0) continue
    runcmd.push(line)
  }

  // `packages` only useful when we're going to apt install; otherwise omit
  // the field so cloud-init doesn't spend boot time refreshing apt indices
  // for nothing.
  const packages = preinstalled ? undefined : ['docker.io', 'docker-compose-v2', 'ca-certificates']

  // Trim empty fields so the JSON we send to Spheron is minimal — easier to
  // diff against `savedCloudInit` for forensic resume tests.
  const out: SpheronCloudInit = {}
  if (packages) out.packages = packages
  if (writeFiles.length > 0) out.writeFiles = writeFiles
  if (runcmd.length > 0) out.runcmd = runcmd
  return out
}
