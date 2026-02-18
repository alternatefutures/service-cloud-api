/**
 * Akash SDL Generator for Templates
 *
 * Takes a template definition + user config overrides and outputs
 * valid Akash SDL YAML. Follows all lessons from INCIDENTS.md (canonical runbook):
 *   - persistent: true + class: beta3 for named storage
 *   - default ephemeral storage entry before named volumes
 *   - signedBy auditor filter
 */

import type { Template, TemplateDeployConfig } from './schema.js'

/**
 * Generate an Akash SDL from a template + user configuration overrides.
 */
export function generateSDLFromTemplate(
  template: Template,
  config?: TemplateDeployConfig,
): string {
  const serviceName = slugify(config?.serviceName || template.id)
  const pricingUakt = template.pricingUakt || 1000

  // ── Merge env vars: template defaults + user overrides ──────
  const envLines = buildEnvLines(template, config?.envOverrides)

  // ── Resources (allow overrides) ─────────────────────────────
  const cpu = config?.resourceOverrides?.cpu ?? template.resources.cpu
  const memory = config?.resourceOverrides?.memory ?? template.resources.memory
  const storage = config?.resourceOverrides?.storage ?? template.resources.storage

  // ── Ports / expose ──────────────────────────────────────────
  const exposeBlock = template.ports
    .map(
      p => `      - port: ${p.port}
        as: ${p.as}
        to:
          - global: ${p.global}`,
    )
    .join('\n')

  // ── Persistent storage (if any) ─────────────────────────────
  const hasPersistent = template.persistentStorage && template.persistentStorage.length > 0
  const storageProfileBlock = buildStorageProfileBlock(storage, template)
  const paramsBlock = hasPersistent ? buildParamsBlock(template) : ''

  // ── Start command override ──────────────────────────────────
  // IMPORTANT: Use `args` (Kubernetes args), NOT `command` (Kubernetes command).
  // In Kubernetes/Akash:
  //   `command:` overrides the Docker ENTRYPOINT
  //   `args:`    overrides the Docker CMD
  // Using `command:` would bypass custom ENTRYPOINT scripts (e.g. the
  // chown/privilege-drop wrappers used by milaidy-akash, openclaw-akash).
  const commandBlock = template.startCommand
    ? `    args:
      - sh
      - -c
      - "${template.startCommand}"\n`
    : ''

  // ── Build the SDL ───────────────────────────────────────────
  return `---
version: "2.0"

services:
  ${serviceName}:
    image: ${template.dockerImage}
${envLines}${commandBlock}    expose:
${exposeBlock}
${paramsBlock}
profiles:
  compute:
    ${serviceName}:
      resources:
        cpu:
          units: ${cpu}
        memory:
          size: ${memory}
        storage:
${storageProfileBlock}

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        ${serviceName}:
          denom: uakt
          amount: ${pricingUakt}

deployment:
  ${serviceName}:
    dcloud:
      profile: ${serviceName}
      count: 1
`
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildEnvLines(
  template: Template,
  overrides?: Record<string, string>,
): string {
  const merged: Record<string, string> = {}

  // Start with template defaults
  for (const v of template.envVars) {
    if (v.default !== null) {
      merged[v.key] = v.default
    }
  }

  // Inject akash-base entrypoint env vars from template.akash config
  if (template.akash) {
    const a = template.akash
    if (a.chownPaths?.length) merged['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
    if (a.runUser) merged['AKASH_RUN_USER'] = a.runUser
    if (a.runUid != null) merged['AKASH_RUN_UID'] = String(a.runUid)
  }

  // Apply user overrides (last, so they win)
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      merged[key] = value
    }
  }

  const entries = Object.entries(merged)
  if (entries.length === 0) return ''

  const lines = entries.map(([k, v]) => `      - ${k}=${v}`).join('\n')
  return `    env:\n${lines}\n`
}

function buildStorageProfileBlock(
  ephemeralSize: string,
  template: Template,
): string {
  const lines: string[] = []

  // Default ephemeral storage (ALWAYS required before named volumes)
  lines.push(`          - size: ${ephemeralSize}`)

  // Named persistent volumes
  if (template.persistentStorage) {
    for (const vol of template.persistentStorage) {
      lines.push(`          - name: ${vol.name}`)
      lines.push(`            size: ${vol.size}`)
      lines.push(`            attributes:`)
      lines.push(`              persistent: true`)
      lines.push(`              class: beta3`)
    }
  }

  return lines.join('\n')
}

function buildParamsBlock(template: Template): string {
  if (!template.persistentStorage || template.persistentStorage.length === 0) {
    return ''
  }

  const mounts = template.persistentStorage
    .map(
      vol => `        ${vol.name}:
          mount: ${vol.mountPath}
          readOnly: false`,
    )
    .join('\n')

  return `    params:
      storage:
${mounts}
`
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
