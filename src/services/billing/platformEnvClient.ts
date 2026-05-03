/**
 * Platform Env Injection Client
 *
 * Auto-injects platform-provided env vars (AF_ORG_ID, AF_API_KEY,
 * generated S3-style credentials) during template deployment. Uses the
 * same service-to-service pattern as the billing API client
 * (AUTH_INTROSPECTION_SECRET).
 */

import { randomBytes } from 'crypto'
import type { Template } from '../../templates/schema.js'
import type { Context } from '../../resolvers/types.js'

/**
 * S3-style access key ID — uppercase alphanumeric, 20 chars (matches
 * AWS / RustFS / minio convention so admins can paste it into any S3
 * client without surprises).
 */
function generateAccessKeyId(): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const targetLength = 20
  const maxUnbiasedByte = Math.floor(256 / ALPHA.length) * ALPHA.length
  let out = ''

  while (out.length < targetLength) {
    const bytes = randomBytes(targetLength - out.length)
    for (let i = 0; i < bytes.length && out.length < targetLength; i++) {
      const byte = bytes[i]!
      if (byte >= maxUnbiasedByte) continue
      out += ALPHA[byte % ALPHA.length]
    }
  }

  return out
}

/**
 * Opaque secret — base64url, 40 chars (>= 240 bits of entropy). Used for
 * S3 secret keys and any other shared-secret env that needs to be strong
 * out-of-the-box.
 */
function generateSecret(): string {
  return randomBytes(40).toString('base64url').slice(0, 40)
}

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
 * - 'orgId'              → injects context.organizationId
 * - 'apiKey'             → creates a scoped PAT via service-auth internal API
 * - 'generatedAccessKey' → random 20-char uppercase alphanumeric (S3 access key)
 * - 'generatedSecret'    → random 40-char base64url (S3 secret / opaque secret)
 *
 * If the user explicitly provided a value in envOverrides for a key, that
 * value wins — generated values only fill in the gaps. This lets advanced
 * users BYO credentials when they want to.
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

    if (envVar.platformInjected === 'generatedAccessKey') {
      envOverrides[envVar.key] = generateAccessKeyId()
    }

    if (envVar.platformInjected === 'generatedSecret') {
      envOverrides[envVar.key] = generateSecret()
    }
  }
}
