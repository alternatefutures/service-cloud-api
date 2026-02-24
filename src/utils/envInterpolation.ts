/**
 * Environment variable interpolation engine.
 *
 * Supports the `{{services.<slug>.<property>}}` syntax to reference other
 * services within the same project.
 *
 * Supported properties:
 *   host       → internalHostname or subdomain URL
 *   port       → first public port (or container port)
 *   url        → full URL (http(s)://<host>:<port>)
 *   env.<KEY>  → a specific env var from the target service
 */

export interface ServiceRef {
  slug: string
  internalHostname: string | null
  ports: Array<{ containerPort: number; publicPort: number | null }>
  envVars: Array<{ key: string; value: string }>
  subdomain?: string
}

const INTERPOLATION_RE = /\{\{services\.([a-z0-9-]+)\.([a-z_.]+)\}\}/gi

/**
 * Resolve all `{{services.*}}` interpolations in a value string.
 * Unknown references are left as-is (to fail loudly at deploy).
 */
export function interpolateEnvValue(
  value: string,
  serviceMap: Record<string, ServiceRef>,
): string {
  return value.replace(INTERPOLATION_RE, (match, slug, prop) => {
    const svc = serviceMap[slug]
    if (!svc) return match

    switch (prop) {
      case 'host':
        return svc.internalHostname ?? svc.subdomain ?? match

      case 'port': {
        const first = svc.ports[0]
        if (!first) return match
        return String(first.publicPort ?? first.containerPort)
      }

      case 'url': {
        const host = svc.internalHostname ?? svc.subdomain
        if (!host) return match
        const port = svc.ports[0]
        if (!port) return host.includes('://') ? host : `http://${host}`
        const p = port.publicPort ?? port.containerPort
        return `http://${host}:${p}`
      }

      default: {
        // env.<KEY> pattern
        if (prop.startsWith('env.')) {
          const envKey = prop.slice(4)
          const envVar = svc.envVars.find(
            (e) => e.key.toUpperCase() === envKey.toUpperCase(),
          )
          return envVar?.value ?? match
        }
        return match
      }
    }
  })
}

/**
 * Build a service lookup map from a set of sibling services.
 */
export function buildServiceMap(
  services: Array<{
    slug: string
    internalHostname: string | null
    envVars: Array<{ key: string; value: string; secret: boolean }>
    ports: Array<{ containerPort: number; publicPort: number | null }>
  }>,
): Record<string, ServiceRef> {
  const map: Record<string, ServiceRef> = {}
  for (const svc of services) {
    map[svc.slug] = {
      slug: svc.slug,
      internalHostname: svc.internalHostname,
      ports: svc.ports,
      envVars: svc.envVars,
    }
  }
  return map
}

/**
 * Resolve all env vars for a given service, interpolating any
 * `{{services.*}}` references using sibling services in the same project.
 */
export function resolveEnvVars(
  envVars: Array<{ key: string; value: string }>,
  serviceMap: Record<string, ServiceRef>,
): Array<{ key: string; value: string }> {
  return envVars.map((ev) => ({
    key: ev.key,
    value: interpolateEnvValue(ev.value, serviceMap),
  }))
}
