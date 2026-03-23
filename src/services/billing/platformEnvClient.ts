/**
 * Platform Env Injection Client
 *
 * Auto-injects platform-provided env vars (AF_ORG_ID, AF_API_KEY)
 * during template deployment. Uses the same service-to-service pattern
 * as the billing API client (AUTH_INTROSPECTION_SECRET).
 */

import type { Template } from '../../templates/schema.js'
import type { Context } from '../../resolvers/types.js'

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:1601'
const INTROSPECTION_SECRET = process.env.AUTH_INTROSPECTION_SECRET || ''

interface CreateTokenResult {
  success: boolean
  token: string
  id: string
  name: string
  organizationId: string | null
}

async function createInternalToken(args: {
  userId: string
  organizationId: string
  name: string
}): Promise<CreateTokenResult> {
  const url = `${AUTH_SERVICE_URL}/tokens/internal/create`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-af-introspection-secret': INTROSPECTION_SECRET,
    },
    body: JSON.stringify(args),
  })

  const body = (await response.json()) as CreateTokenResult & { error?: string }

  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`)
    ;(error as any).statusCode = response.status
    throw error
  }

  return body
}

/**
 * Scan a template's envVars for `platformInjected` fields and inject
 * the appropriate values into envOverrides.
 *
 * - 'orgId'  → injects context.organizationId
 * - 'apiKey' → creates a scoped PAT via service-auth internal API
 *
 * Mutates envOverrides in place.
 */
export async function injectPlatformEnvVars(
  template: Template,
  envOverrides: Record<string, string>,
  context: Context,
  slug: string
): Promise<void> {
  const platformVars = template.envVars.filter(v => v.platformInjected)
  if (platformVars.length === 0) return

  for (const envVar of platformVars) {
    if (envOverrides[envVar.key]) continue

    if (envVar.platformInjected === 'orgId') {
      if (!context.organizationId) {
        throw new Error('Organization ID required for platform-injected env var')
      }
      envOverrides[envVar.key] = context.organizationId
    }

    if (envVar.platformInjected === 'apiKey') {
      if (!context.userId || !context.organizationId) {
        throw new Error('User and organization required for API key generation')
      }
      const result = await createInternalToken({
        userId: context.userId,
        organizationId: context.organizationId,
        name: `auto: ${template.name} (${slug})`,
      })
      envOverrides[envVar.key] = result.token
    }
  }
}
