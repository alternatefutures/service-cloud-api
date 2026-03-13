/**
 * Akash SDL Generator for Templates
 *
 * Takes a template definition + user config overrides and outputs
 * valid Akash SDL YAML. Follows all lessons from INCIDENTS.md (canonical runbook):
 *   - persistent: true + class: beta3 for named storage
 *   - default ephemeral storage entry before named volumes
 *   - signedBy auditor filter
 */

import { randomBytes } from 'crypto'
import type {
  Template,
  TemplateComponent,
  TemplateDeployConfig,
  TemplateGpu,
  TemplatePort,
  TemplatePersistentStorage,
  TemplateResources,
  TemplateEnvVar,
  TemplateAkashConfig,
} from './schema.js'

function generatePassword(len = 32): string {
  return randomBytes(len).toString('base64url').slice(0, len)
}

function generateBase64Secret(len = 32): string {
  return randomBytes(len).toString('base64')
}

/**
 * Generate an Akash SDL from a template + user configuration overrides.
 * If the template has a `customSdl`, uses it directly (with placeholder
 * replacement and env overrides) instead of auto-generating.
 */
export function generateSDLFromTemplate(
  template: Template,
  config?: TemplateDeployConfig
): string {
  const serviceName = slugify(config?.serviceName || template.id)

  if (template.customSdl) {
    return resolveCustomSdl(template, config, serviceName)
  }

  const pricingUakt = template.pricingUakt || 1000

  // ── Merge env vars: template defaults + user overrides ──────
  const envLines = buildEnvLines(template, config?.envOverrides)

  // ── Resources (allow overrides) ─────────────────────────────
  const cpu = config?.resourceOverrides?.cpu ?? template.resources.cpu
  const memory = config?.resourceOverrides?.memory ?? template.resources.memory
  const storage =
    config?.resourceOverrides?.storage ?? template.resources.storage

  // GPU: null override = explicitly disabled; undefined = use template default
  const gpu: TemplateGpu | undefined =
    config?.resourceOverrides?.gpu === null
      ? undefined
      : (config?.resourceOverrides?.gpu ?? template.resources.gpu)

  // ── Ports / expose ──────────────────────────────────────────
  const exposeBlock = template.ports
    .map(
      p => `      - port: ${p.port}
        as: ${p.as}
        to:
          - global: ${p.global}`
    )
    .join('\n')

  // ── Persistent storage (if any) ─────────────────────────────
  const hasPersistent =
    template.persistentStorage && template.persistentStorage.length > 0
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

  // ── GPU resource block ────────────────────────────────────────
  const gpuBlock = gpu ? buildGpuProfileBlock(gpu) : ''

  // GPU providers may not be in the auditor list — skip signedBy for GPU deploys
  const placementBlock = gpu
    ? `  placement:
    dcloud:
      pricing:
        ${serviceName}:
          denom: uakt
          amount: ${pricingUakt}`
    : `  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        ${serviceName}:
          denom: uakt
          amount: ${pricingUakt}`

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
${gpuBlock}        storage:
${storageProfileBlock}

${placementBlock}

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
  overrides?: Record<string, string>
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
    if (a.chownPaths?.length)
      merged['AKASH_CHOWN_PATHS'] = a.chownPaths.join(':')
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

function buildGpuProfileBlock(gpu: TemplateGpu): string {
  const modelLine = gpu.model ? `\n                - model: ${gpu.model}` : ''
  return `        gpu:
          units: ${gpu.units}
          attributes:
            vendor:
              ${gpu.vendor}:${modelLine}
`
}

function buildStorageProfileBlock(
  ephemeralSize: string,
  template: Template
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
          readOnly: false`
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

/**
 * Resolve a customSdl template: replace placeholders, merge env overrides.
 * @deprecated Use generateCompositeSDL for new composite templates.
 */
function resolveCustomSdl(
  template: Template,
  config: TemplateDeployConfig | undefined,
  serviceName: string
): string {
  const password = generatePassword()
  const secret = generateBase64Secret()

  const envDefaults: Record<string, string> = {}
  for (const v of template.envVars) {
    if (v.default !== null) envDefaults[v.key] = v.default
  }
  if (config?.envOverrides) {
    for (const [k, v] of Object.entries(config.envOverrides)) {
      envDefaults[k] = v
    }
  }

  let sdl = template.customSdl!
  sdl = sdl.replace(/\{\{SERVICE_NAME}}/g, serviceName)
  sdl = sdl.replace(/\{\{GENERATED_PASSWORD}}/g, password)
  sdl = sdl.replace(/\{\{GENERATED_SECRET}}/g, secret)
  sdl = sdl.replace(
    /\{\{ENV\.([^}]+)}}/g,
    (_match, key) => envDefaults[key] ?? ''
  )

  return sdl
}

// ─── Composite SDL Generator ─────────────────────────────────────

/**
 * Fully resolved component ready for SDL generation. Created by
 * resolveComponents() in the deployment resolver.
 */
export interface ResolvedComponent {
  id: string
  sdlServiceName: string
  dockerImage: string
  resources: TemplateResources
  ports: TemplatePort[]
  envVars: TemplateEnvVar[]
  persistentStorage: TemplatePersistentStorage[]
  healthCheck?: { path: string; port: number }
  startCommand?: string
  akash?: TemplateAkashConfig
  pricingUakt: number
  internalOnly: boolean
  /** Merged env: template defaults + envDefaults + resolved envLinks */
  resolvedEnv: Record<string, string>
}

/**
 * Context passed to the envLinks resolver so it knows how to resolve
 * cross-component placeholders based on co-location.
 */
export interface CompositeContext {
  /** componentId → slug assigned at service creation */
  slugs: Record<string, string>
  /** componentId → group from topology targets */
  groups: Record<string, string>
  /** componentId → provider from topology targets */
  providers: Record<string, 'akash' | 'phala'>
  /** Shared generated secrets for this deployment */
  password: string
  secret: string
}

// Deployed containers always connect via the production proxy domain,
// regardless of whether service-cloud-api runs locally or in production.
const DEPLOY_DOMAIN = process.env.PROXY_DEPLOY_DOMAIN || 'alternatefutures.ai'

function getProxyUrlForSlug(slug: string): string {
  return `${slug}-app.${DEPLOY_DOMAIN}`
}

function getProxyHttpUrl(slug: string): string {
  return `https://${getProxyUrlForSlug(slug)}`
}

function getProxyWsUrl(slug: string): string {
  return `wss://${getProxyUrlForSlug(slug)}`
}

/**
 * Resolve envLinks placeholders for a component given the composite context.
 * Returns a Record of env key → resolved value.
 */
export function resolveEnvLinks(
  envLinks: Record<string, string>,
  componentId: string,
  allComponents: ResolvedComponent[],
  ctx: CompositeContext
): Record<string, string> {
  const resolved: Record<string, string> = {}
  const componentMap = new Map(allComponents.map(c => [c.id, c]))

  for (const [key, tpl] of Object.entries(envLinks)) {
    resolved[key] = tpl.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
      if (expr === 'generated.password') return ctx.password
      if (expr === 'generated.secret') return ctx.secret

      const compMatch = expr.match(/^component\.([^.]+)\.(.+)$/)
      if (!compMatch) return _match

      const [, targetId, field] = compMatch
      const targetSlug = ctx.slugs[targetId]
      if (!targetSlug) return _match

      if (field === 'proxyUrl') {
        return getProxyUrlForSlug(targetSlug)
      }

      if (field === 'proxyHttpUrl') {
        return getProxyHttpUrl(targetSlug)
      }

      if (field === 'proxyWsUrl') {
        return getProxyWsUrl(targetSlug)
      }

      if (field === 'host') {
        const sameGroup = ctx.groups[componentId] === ctx.groups[targetId]
        const bothAkash =
          ctx.providers[componentId] === 'akash' &&
          ctx.providers[targetId] === 'akash'
        if (sameGroup && bothAkash) {
          const target = componentMap.get(targetId)
          return target?.sdlServiceName ?? targetId
        }
        return getProxyUrlForSlug(targetSlug)
      }

      const envMatch = field.match(/^env\.(.+)$/)
      if (envMatch) {
        const envKey = envMatch[1]
        const target = componentMap.get(targetId)
        return target?.resolvedEnv[envKey] ?? ''
      }

      return _match
    })
  }

  return resolved
}

/**
 * Generate a multi-service Akash SDL from resolved components.
 * All components passed here belong to the same Akash deployment group.
 */
export function generateCompositeSDL(components: ResolvedComponent[]): string {
  const hasGpu = components.some(c => c.resources.gpu)

  // ── Services block ────────────────────────────────────────────
  const servicesBlock = components
    .map(comp => {
      const envEntries = Object.entries(comp.resolvedEnv)
      const envBlock =
        envEntries.length > 0
          ? `    env:\n${envEntries.map(([k, v]) => `      - ${k}=${v}`).join('\n')}\n`
          : ''

      const commandBlock = comp.startCommand
        ? `    command:\n      - /bin/sh\n      - -c\n    args:\n      - |\n        ${comp.startCommand.split('\n').join('\n        ')}\n`
        : ''

      const consumers = components.filter(
        c => c.id !== comp.id && !c.internalOnly
      )
      const exposeLines = comp.ports
        .map(p => {
          if (comp.internalOnly && consumers.length > 0) {
            const toLines = consumers
              .map(c => `          - service: ${c.sdlServiceName}`)
              .join('\n')
            return `      - port: ${p.port}
        to:
${toLines}`
          }
          return `      - port: ${p.port}
        as: ${p.as}
        to:
          - global: true`
        })
        .join('\n')

      const hasPersist = comp.persistentStorage.length > 0
      let paramsBlock = ''
      if (hasPersist) {
        const mounts = comp.persistentStorage
          .map(
            vol =>
              `        ${vol.name}:\n          mount: ${vol.mountPath}\n          readOnly: false`
          )
          .join('\n')
        paramsBlock = `    params:\n      storage:\n${mounts}\n`
      }

      return `  ${comp.sdlServiceName}:
    image: ${comp.dockerImage}
${envBlock}${commandBlock}    expose:
${exposeLines}
${paramsBlock}`
    })
    .join('\n')

  // ── Compute profiles ──────────────────────────────────────────
  const computeBlock = components
    .map(comp => {
      const gpu = comp.resources.gpu
      const gpuBlock = gpu ? buildGpuProfileBlock(gpu) : ''

      const storageLines: string[] = []
      storageLines.push(`          - size: ${comp.resources.storage}`)
      for (const vol of comp.persistentStorage) {
        storageLines.push(`          - name: ${vol.name}`)
        storageLines.push(`            size: ${vol.size}`)
        storageLines.push(`            attributes:`)
        storageLines.push(`              persistent: true`)
        storageLines.push(`              class: beta3`)
      }

      return `    ${comp.sdlServiceName}:
      resources:
        cpu:
          units: ${comp.resources.cpu}
        memory:
          size: ${comp.resources.memory}
${gpuBlock}        storage:
${storageLines.join('\n')}`
    })
    .join('\n\n')

  // ── Placement / pricing ───────────────────────────────────────
  const pricingLines = components
    .map(
      c =>
        `        ${c.sdlServiceName}:\n          denom: uakt\n          amount: ${c.pricingUakt}`
    )
    .join('\n')

  // Multi-service deployments (especially with persistent storage) already
  // drastically limit the provider pool. Skip the signedBy auditor filter
  // to avoid zero-bid situations.
  const hasPersistent = components.some(c => c.persistentStorage.length > 0)
  const skipAuditor = hasGpu || hasPersistent || components.length > 1

  const placementBlock = skipAuditor
    ? `  placement:
    dcloud:
      pricing:
${pricingLines}`
    : `  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
${pricingLines}`

  // ── Deployment block ──────────────────────────────────────────
  const deployBlock = components
    .map(
      c =>
        `  ${c.sdlServiceName}:\n    dcloud:\n      profile: ${c.sdlServiceName}\n      count: 1`
    )
    .join('\n')

  return `---
version: "2.0"

services:
${servicesBlock}
profiles:
  compute:
${computeBlock}

${placementBlock}

deployment:
${deployBlock}
`
}

export { slugify, generatePassword, generateBase64Secret }
