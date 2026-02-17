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

/**
 * Generate docker-compose.yml content from a template + user config.
 * Returns the YAML string suitable for `phala deploy -c` or `phala cvms create --compose`.
 */
export function generateComposeFromTemplate(
  template: Template,
  config?: TemplateDeployConfig,
): string {
  const envLines = buildEnvLines(template, config?.envOverrides)
  const portLines = buildPortLines(template)
  const volumeLines = buildVolumeLines(template)
  const commandBlock = template.startCommand
    ? `    command: ["sh", "-c", "${escapeYamlString(template.startCommand)}"]\n`
    : ''

  let yaml = `services:
  app:
    image: ${template.dockerImage}
${envLines}${commandBlock}    ports:
${portLines}
    volumes:
      - /var/run/tappd.sock:/var/run/tappd.sock
${volumeLines}
`

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
