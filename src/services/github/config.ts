/**
 * GitHub App configuration loader.
 *
 * Env vars are populated by `infra/github-app/capture-credentials.mjs` after
 * the manifest-flow registration. The private key is base64-encoded so it
 * survives `.env` files (PEM has multiline content + newline-sensitive parsers).
 */

let cached: GithubAppConfig | null = null

export interface GithubAppConfig {
  appId: string
  appSlug: string
  clientId: string
  clientSecret: string
  webhookSecret: string
  privateKeyPem: string
  /**
   * GHCR push identity used by the builder Job. Defaults to the App slug;
   * override via env if you push under a different bot account.
   */
  ghcrUser: string
  /**
   * GHCR namespace (org/user under which built images are published).
   * E.g. `alternatefutures` -> `ghcr.io/alternatefutures/<userid>--<repo>:<sha>`.
   */
  ghcrNamespace: string
  /**
   * PAT with `write:packages` scope used by the builder for `docker push`.
   * Distinct from the App installation token because installation tokens
   * cannot push to ghcr (only repo contents). Stored in the same K8s
   * secret as the rest of the app config.
   */
  ghcrPushToken: string
}

export class GithubAppConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `GitHub App is not configured. Missing env: ${missing.join(', ')}. ` +
        `Run \`node infra/github-app/capture-credentials.mjs\` then re-source your env.`,
    )
    this.name = 'GithubAppConfigError'
  }
}

export function isGithubAppConfigured(): boolean {
  try {
    getGithubAppConfig()
    return true
  } catch {
    return false
  }
}

export function getGithubAppConfig(): GithubAppConfig {
  if (cached) return cached

  const required: Record<string, string | undefined> = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
    GITHUB_APP_PRIVATE_KEY_B64: process.env.GITHUB_APP_PRIVATE_KEY_B64,
    GHCR_PUSH_TOKEN: process.env.GHCR_PUSH_TOKEN,
  }
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length > 0) {
    throw new GithubAppConfigError(missing)
  }

  const privateKeyPem = Buffer.from(required.GITHUB_APP_PRIVATE_KEY_B64!, 'base64').toString('utf8')

  cached = {
    appId: required.GITHUB_APP_ID!,
    appSlug: required.GITHUB_APP_SLUG!,
    clientId: required.GITHUB_APP_CLIENT_ID!,
    clientSecret: required.GITHUB_APP_CLIENT_SECRET!,
    webhookSecret: required.GITHUB_APP_WEBHOOK_SECRET!,
    privateKeyPem,
    ghcrUser: process.env.GHCR_USER || required.GITHUB_APP_SLUG!,
    ghcrNamespace: process.env.GHCR_NAMESPACE || 'alternatefutures',
    ghcrPushToken: required.GHCR_PUSH_TOKEN!,
  }
  return cached
}

/** Test-only — clears the cached config so a new env can be loaded. */
export function _resetGithubAppConfigCache() {
  cached = null
}
