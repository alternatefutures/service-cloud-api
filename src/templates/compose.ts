/**
 * Phala Docker Compose Generator for Templates
 *
 * Maps Template objects to docker-compose.yml for Phala Cloud CVMs.
 * Follows PHALA_IMPLEMENTATION.md rules:
 *   - Single service named `app`
 *   - Ports: template { port, as } → compose "<external>:<internal>"
 *   - Env: template defaults + envOverrides (never log secret values)
 *   - Persistent storage: named volumes + mount
 *   - TEE socket: /var/run/tappd.sock for in-app attestation
 */

import type { Template, TemplateDeployConfig } from './schema.js'
import type { ResolvedComponent } from './sdl.js'

/**
 * Generate docker-compose.yml content from a template + user config.
 * Returns the YAML string suitable for `phala deploy -c` or `phala cvms create --compose`.
 *
 * `target` selects provider-specific tweaks:
 *   - 'phala' (default): mounts /var/run/tappd.sock (TEE attestation socket).
 *   - 'spheron': drops the tappd mount (it doesn't exist on Spheron's plain
 *     Ubuntu VMs) AND injects `sleep infinity` if the template has no
 *     startCommand. Without this, bare base images like `ubuntu:24.04`
 *     start, run their default CMD (bash), and immediately exit, leaving
 *     the VM with zero running containers and our cloud-init probe
 *     waiting forever for one.
 */
export function generateComposeFromTemplate(
  template: Template,
  config?: TemplateDeployConfig & { target?: 'phala' | 'spheron' },
): string {
  const target = config?.target ?? 'phala'
  const envLines = buildEnvLines(template, config?.envOverrides)
  const portLines = buildPortLines(template)
  const volumeLines = buildVolumeLines(template)
  const effectiveStartCommand =
    template.startCommand ?? (target === 'spheron' ? 'sleep infinity' : null)
  const commandBlock = effectiveStartCommand
    ? `    command: ["sh", "-c", "${escapeYamlString(effectiveStartCommand)}"]\n`
    : ''

  const tappdMount = target === 'phala' ? '      - /var/run/tappd.sock:/var/run/tappd.sock\n' : ''
  const volumesBlock =
    tappdMount || volumeLines
      ? `    volumes:\n${tappdMount}${volumeLines}\n`
      : ''

  let yaml = `services:
  app:
    image: ${template.dockerImage}
${envLines}${commandBlock}    ports:
${portLines}
${volumesBlock}`

  if (template.persistentStorage && template.persistentStorage.length > 0) {
    yaml += `volumes:
${template.persistentStorage.map(v => `  ${v.name}: {}`).join('\n')}
`
  }

  return yaml
}

/**
 * Get env var keys only (for logging/storage — never values).
 */
export function getEnvKeysFromTemplate(
  template: Template,
  overrides?: Record<string, string>,
): string[] {
  const keys = new Set<string>()
  for (const v of template.envVars) {
    keys.add(v.key)
  }
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      keys.add(k)
    }
  }
  return Array.from(keys)
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildEnvLines(
  template: Template,
  overrides?: Record<string, string>,
): string {
  const merged: Record<string, string> = {}

  for (const v of template.envVars) {
    if (v.default !== null) {
      merged[v.key] = v.default
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      merged[key] = value
    }
  }

  const entries = Object.entries(merged)
  if (entries.length === 0) return ''

  const lines = entries.map(([k, v]) => `      - ${k}=${escapeYamlString(v)}`).join('\n')
  return `    environment:\n${lines}\n`
}

function buildPortLines(template: Template): string {
  return template.ports
    .map(p => `      - "${p.as}:${p.port}"`)
    .join('\n')
}

function buildVolumeLines(template: Template): string {
  if (!template.persistentStorage || template.persistentStorage.length === 0) {
    return ''
  }
  return template.persistentStorage
    .map(v => `      - ${v.name}:${v.mountPath}`)
    .join('\n')
}

function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// ─── Raw Service Compose Generator ──────────────────────────────

export interface RawServiceConfig {
  dockerImage: string
  ports: Array<{ containerPort: number; publicPort?: number | null }>
  envVars: Array<{ key: string; value: string }>
  startCommand?: string | null
  /**
   * Service.containerPort fallback. Used when `ports` is empty (the common
   * case for raw Docker / GitHub-source flows where users only set the
   * single "Container port" field on the service). Without this, postgres
   * with containerPort=5432 would silently expose 80:80 and the
   * subdomain proxy (which resolves to `:5432`) would 502 forever.
   */
  containerPort?: number | null
  /**
   * If true, default the fallback port to 3000 instead of 80. GitHub-built
   * apps (Next.js, Nuxt, Bun, Vite) listen on 3000 overwhelmingly often,
   * and 80 is the single biggest source of "deploy succeeds but URL 404s"
   * reports. Mirrors the Akash side (`akash/orchestrator.ts:fallbackPort`).
   */
  isGithubBuild?: boolean
  /**
   * Persistent volumes for raw (non-template) Docker services. Templates
   * own their own volumes via `template.persistentStorage`. Pass the
   * `parseServiceVolumes(service.volumes)` output here so the compose
   * survives container restarts (in-VM persistence; cross-deploy
   * persistence is a separate concern — Spheron VMs are ephemeral).
   */
  volumes?: Array<{ name: string; mountPath: string; size?: string }>
  /**
   * Provider-specific tweaks. Mirrors `generateComposeFromTemplate`:
   *   - 'phala' (default): mounts /var/run/tappd.sock for TEE attestation.
   *   - 'spheron': drops the tappd mount (Spheron VMs are plain Ubuntu, no
   *     TEE socket exists). Spheron callers are responsible for passing
   *     `startCommand: 'sleep infinity'` when the image is a bare base OS
   *     (e.g. ubuntu:24.04) — see `resolvers/spheron.ts`.
   */
  target?: 'phala' | 'spheron'
}

/**
 * Generate docker-compose.yml for a raw (non-template) service.
 * Uses the service's own dockerImage, ports, env vars, and persistent
 * volumes. Same shape works for any ServiceType (VM, DATABASE, SITE,
 * FUNCTION, CRON) — the resolver decides what `startCommand` to inject
 * based on `service.type` and whether the dockerImage is a daemon.
 */
export function generateComposeFromService(config: RawServiceConfig): string {
  const target = config.target ?? 'phala'
  const envEntries = config.envVars
  const envBlock = envEntries.length > 0
    ? `    environment:\n${envEntries.map(e => `      - ${e.key}=${escapeYamlString(e.value)}`).join('\n')}\n`
    : ''

  // ── Port resolution ────────────────────────────────────────────────
  // Priority:
  //   1. Any port row with publicPort set → "publicPort:containerPort"
  //   2. First port row → "containerPort:containerPort" (1:1 mapping;
  //      keeps the subdomain proxy lookup deterministic)
  //   3. service.containerPort fallback → "containerPort:containerPort"
  //   4. Github-source heuristic → "3000:3000"
  //   5. Plain default → "80:80"
  const portMappings: string[] = []
  for (const p of config.ports) {
    if (p.publicPort != null) {
      portMappings.push(`      - "${p.publicPort}:${p.containerPort}"`)
    }
  }
  if (portMappings.length === 0) {
    const fallback =
      config.ports[0]?.containerPort ??
      config.containerPort ??
      (config.isGithubBuild ? 3000 : 80)
    portMappings.push(`      - "${fallback}:${fallback}"`)
  }
  const portBlock = `    ports:\n${portMappings.join('\n')}\n`

  const commandBlock = config.startCommand
    ? `    command: ["sh", "-c", "${escapeYamlString(config.startCommand)}"]\n`
    : ''

  // ── Volume resolution ──────────────────────────────────────────────
  // Combine the Phala tappd mount (when target='phala') with any named
  // persistent volumes the caller supplied. Both share the `volumes:`
  // block under the service.
  const volumeMounts: string[] = []
  if (target === 'phala') {
    volumeMounts.push('      - /var/run/tappd.sock:/var/run/tappd.sock')
  }
  if (config.volumes) {
    for (const v of config.volumes) {
      volumeMounts.push(`      - ${v.name}:${v.mountPath}`)
    }
  }
  const volumesBlock = volumeMounts.length > 0
    ? `    volumes:\n${volumeMounts.join('\n')}\n`
    : ''

  // Top-level `volumes:` declaration for any named persistent volumes.
  // Without this, Docker Compose treats `name:mountPath` as a bind mount
  // against `./name` on the VM (broken for fresh VMs).
  const namedVolumes = config.volumes ?? []
  const topLevelVolumesBlock = namedVolumes.length > 0
    ? `volumes:\n${namedVolumes.map(v => `  ${v.name}: {}`).join('\n')}\n`
    : ''

  return `services:
  app:
    image: ${config.dockerImage}
${envBlock}${commandBlock}${portBlock}${volumesBlock}${topLevelVolumesBlock}`
}

// ─── Composite Compose Generator ────────────────────────────────

/**
 * Generate a docker-compose.yml for a single resolved component
 * targeting Phala. Phala CVMs are single-container, so each component
 * gets its own compose. envLinks are pre-resolved to AF proxy URLs.
 */
export function generateCompositeCompose(component: ResolvedComponent): string {
  const envEntries = Object.entries(component.resolvedEnv)
  const envBlock = envEntries.length > 0
    ? `    environment:\n${envEntries.map(([k, v]) => `      - ${k}=${escapeYamlString(v)}`).join('\n')}\n`
    : ''

  const portBlock = component.ports.length > 0
    ? `    ports:\n${component.ports.map(p => `      - "${p.as}:${p.port}"`).join('\n')}\n`
    : ''

  const commandBlock = component.startCommand
    ? `    command: ["sh", "-c", "${escapeYamlString(component.startCommand)}"]\n`
    : ''

  const hasVolumes = component.persistentStorage.length > 0
  const volumeMounts = hasVolumes
    ? component.persistentStorage.map(v => `      - ${v.name}:${v.mountPath}`).join('\n') + '\n'
    : ''

  let yaml = `services:
  app:
    image: ${component.dockerImage}
${envBlock}${commandBlock}${portBlock}    volumes:
      - /var/run/tappd.sock:/var/run/tappd.sock
${volumeMounts}
`

  if (hasVolumes) {
    yaml += `volumes:\n${component.persistentStorage.map(v => `  ${v.name}: {}`).join('\n')}\n`
  }

  return yaml
}
