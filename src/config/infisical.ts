import { InfisicalClient, LogLevel } from '@infisical/sdk'
import { setInterval } from 'node:timers'

let client: InfisicalClient | null = null
const secretsCache: Record<string, string> = {}

export async function initInfisical() {
  if (process.env.INFISICAL_TOKEN) {
    console.log('🔐 Initializing Infisical client...')

    // Initialize client with service token authentication
    client = new InfisicalClient({
      siteUrl:
        process.env.INFISICAL_SITE_URL || 'https://secrets.alternatefutures.ai',
      logLevel: LogLevel.Error,
    })

    // Authenticate with service token
    await client.auth().serviceToken({
      serviceToken: process.env.INFISICAL_TOKEN,
    })

    // Fetch all secrets
    const secrets = await client.listSecrets({
      environment: process.env.INFISICAL_ENVIRONMENT || 'production',
      projectId: process.env.INFISICAL_PROJECT_ID!,
    })

    // Cache in memory
    secrets.forEach(secret => {
      secretsCache[secret.secretKey] = secret.secretValue
      // Inject into process.env for compatibility
      process.env[secret.secretKey] = secret.secretValue
    })

    console.log(`✅ Loaded ${secrets.length} secrets from Infisical`)
  } else {
    console.log('⚠️  No INFISICAL_TOKEN found, using local .env file')
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
