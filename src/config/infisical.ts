import { InfisicalSDK, type Secret } from '@infisical/sdk'
import { setInterval } from 'node:timers'

let client: InfisicalSDK | null = null
const secretsCache: Record<string, string> = {}

export async function initInfisical() {
  if (process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET) {
    console.log('🔐 Initializing Infisical client...')

    // Initialize client
    client = new InfisicalSDK({
      siteUrl:
        process.env.INFISICAL_SITE_URL || 'https://secrets.alternatefutures.ai',
    })

    // Authenticate with Universal Auth (Machine Identity)
    await client.auth().universalAuth.login({
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    })

    // Fetch all secrets
    const result = await client.secrets().listSecrets({
      environment: process.env.INFISICAL_ENVIRONMENT || 'production',
      projectId: process.env.INFISICAL_PROJECT_ID!,
    })

    // Cache in memory
    result.secrets.forEach((secret: Secret) => {
      secretsCache[secret.secretKey] = secret.secretValue
      // Inject into process.env for compatibility
      process.env[secret.secretKey] = secret.secretValue
    })

    console.log(`✅ Loaded ${result.secrets.length} secrets from Infisical`)
  } else {
    console.log(
      '⚠️  No INFISICAL_CLIENT_ID/SECRET found, using local .env file'
    )
    // Fall back to .env for local development
    const dotenv = await import('dotenv')
    dotenv.config()
  }
}

export function getSecret(key: string): string {
  const value = secretsCache[key] || process.env[key]
  if (!value) {
    throw new Error(`Secret ${key} not found in Infisical or environment`)
  }
  return value
}

export async function refreshSecrets() {
  if (client) {
    console.log('🔄 Refreshing secrets from Infisical...')
    await initInfisical()
  }
}

// Refresh secrets every hour in production
if (process.env.NODE_ENV === 'production') {
  setInterval(
    () => {
      refreshSecrets().catch(console.error)
    },
    60 * 60 * 1000
  ) // 1 hour
}
