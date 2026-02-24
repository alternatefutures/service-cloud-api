/**
 * Connection string resolver for database templates.
 *
 * When a service links to a database (e.g. PostgreSQL, Redis), this module
 * resolves the template's `connectionStrings` map, replacing:
 *   {{host}}       → target service internal hostname or subdomain
 *   {{port}}       → target service first public/container port
 *   {{env.KEY}}    → target service env var value
 */

import type { Template } from '../templates/schema.js'

export interface TargetServiceContext {
  internalHostname: string | null
  slug: string
  ports: Array<{ containerPort: number; publicPort: number | null }>
  envVars: Array<{ key: string; value: string }>
}

const PLACEHOLDER_RE = /\{\{(host|port|env\.([A-Z0-9_]+))\}\}/gi

/**
 * Resolve a single connection string template value.
 */
function resolveValue(template: string, ctx: TargetServiceContext): string {
  return template.replace(PLACEHOLDER_RE, (match, full, envKey) => {
    if (full === 'host') {
      return ctx.internalHostname ?? `${ctx.slug}-app.alternatefutures.ai`
    }
    if (full === 'port') {
      const first = ctx.ports[0]
      return first ? String(first.publicPort ?? first.containerPort) : match
    }
    if (envKey) {
      const ev = ctx.envVars.find(
        (e) => e.key.toUpperCase() === envKey.toUpperCase(),
      )
      return ev?.value ?? match
    }
    return match
  })
}

/**
 * Given a template's connectionStrings map and the target service context,
 * return resolved env var entries to inject on the source service.
 */
export function resolveConnectionStrings(
  connectionStrings: Record<string, string>,
  ctx: TargetServiceContext,
): Array<{ key: string; value: string }> {
  return Object.entries(connectionStrings).map(([key, tpl]) => ({
    key,
    value: resolveValue(tpl, ctx),
  }))
}

/**
 * Get the connection string template map for a template, if it has one.
 */
export function getConnectionStringsForTemplate(
  template: Template | undefined,
): Record<string, string> | null {
  return template?.connectionStrings ?? null
}
