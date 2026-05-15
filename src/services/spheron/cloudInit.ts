/**
 * Spheron cloud-init builder.
 *
 * Spheron VMs ship as plain Ubuntu — there is no native container orchestration.
 * To run our compose-based templates on them we hand-roll Docker bring-up via
 * cloud-init (`runcmd` only — see ordering note below). This module is the
 * single place that decision lives.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Spheron `writeFiles` ordering bug (root-caused on datacrunch fin-02):
 *
 * Spheron's deployment service does NOT pass cloud-config through to the VM
 * verbatim. It transforms `runcmd` + `writeFiles` into a single base64-encoded
 * `/root/startup.sh` and a shimmed `runcmd` that just `bash`'es that script.
 * The transformation flattens both arrays in the wrong order: every entry of
 * `runcmd` runs FIRST, then every `writeFiles` entry is rendered as a
 * `cat > $path <<'EOF' ... EOF` block AFTER. With `set -e` at the top of the
 * generated script, our `cd /opt/af && docker compose up -d` line aborts the
 * whole script (directory not yet created) — and the file writes never
 * execute. Cloud-init's `scripts_user` reports FAILED, /opt/af stays empty,
 * `docker ps` returns 0 containers forever, our 240-attempt cloudinit probe
 * times out at ~20 min, the deployment is marked PERMANENTLY_FAILED while the
 * VM keeps running and Spheron keeps billing us.
 *
 * Fix: stop using `writeFiles` entirely for `/opt/af/docker-compose.yml` and
 * `/opt/af/.env`. Inline both writes as `base64 -d`-from-stdin lines INSIDE
 * `runcmd`, ordered explicitly BEFORE the `docker compose up` line. Spheron's
 * transformer preserves intra-`runcmd` order, so this ordering survives the
 * transformation. Base64 is used (rather than a heredoc) so we don't have to
 * worry about EOF-marker collisions, YAML quoting of multi-line strings, or
 * the fact that some upstream providers' transformers re-wrap heredoc bodies.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Locked decision: smart-pick — prefer pre-installed Docker, fall back to
 * apt-installed Docker.
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
 *     secrets (see plaintext-env audit notes in AF_DEVELOPMENT_PROCESS.md).
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
   * Architecture: cloudInit runs `ufw allow <port>/tcp || true` for each
   * entry; HTTPS termination is the user's problem (Caddy sidecar
   * deferred). The `|| true` is intentional: not every base image installs
   * UFW
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
  const hasCompose = !!(input.composeContent && input.composeContent.trim().length > 0)
  const envContent = hasCompose ? renderEnvFile(input.envVars) : ''

  // Build runcmd in a precise order:
  //   1. (optional) apt install Docker — ONLY when not preinstalled
  //   2. systemctl enable --now docker — idempotent on both branches
  //   3. (optional) ufw allow <port>/tcp — ONLY when exposePorts present
  //   4. (optional) materialize /opt/af/docker-compose.yml + .env from base64
  //      AND `docker compose up -d` — ONLY when composeContent present
  //   5. (optional) extraRuncmd — caller-supplied post-bring-up lines
  //
  // Steps 4's writes used to live in cloud-init `writeFiles`. They no longer
  // do — see the file header for the Spheron writeFiles ordering bug.
  // Inlining via `base64 -d` keeps the writes inside `runcmd` so Spheron's
  // flatten-and-reorder transformer can't sequence them after the bring-up.
  const runcmd: string[] = []

  if (!preinstalled) {
    // `apt-get update` first so the package index is fresh on the cold image;
    // `-y` to keep the boot non-interactive; redirect stderr to surface in
    // cloud-init's logs without breaking on harmless "delaying package
    // configuration" notices.
    runcmd.push('apt-get update -y')
    runcmd.push('DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 ca-certificates')
  }

  // Idempotent — safe on both preinstalled and apt-installed paths.
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

  if (hasCompose) {
    // Base64-encode the file bodies so we can write them with single-line
    // `runcmd` entries and avoid every quoting / heredoc-EOF / YAML-multiline
    // pitfall. Spheron's transformer preserves intra-`runcmd` ordering, so
    // listing the writes BEFORE the bring-up guarantees the files exist when
    // `docker compose up` runs.
    const composeB64 = Buffer.from(input.composeContent ?? '', 'utf8').toString('base64')
    const envB64 = Buffer.from(envContent, 'utf8').toString('base64')

    runcmd.push('mkdir -p /opt/af')
    runcmd.push(`echo ${composeB64} | base64 -d > ${COMPOSE_PATH}`)
    runcmd.push(`chown root:root ${COMPOSE_PATH}`)
    runcmd.push(`chmod 0644 ${COMPOSE_PATH}`)
    // Always lay down a .env (possibly empty) so `--env-file .env` doesn't
    // ENOENT inside the bring-up command.
    runcmd.push(`echo ${envB64} | base64 -d > ${ENV_PATH}`)
    runcmd.push(`chown root:root ${ENV_PATH}`)
    // 0600 — env may carry secrets. See file header security note.
    runcmd.push(`chmod 0600 ${ENV_PATH}`)
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

  // No `writeFiles` ever — see file header for the Spheron ordering bug.
  // Trim empty fields so the JSON we send to Spheron is minimal — easier to
  // diff against `savedCloudInit` for forensic resume tests.
  const out: SpheronCloudInit = {}
  if (packages) out.packages = packages
  if (runcmd.length > 0) out.runcmd = runcmd
  return out
}
