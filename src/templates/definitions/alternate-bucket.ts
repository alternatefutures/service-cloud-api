import type { Template } from '../schema.js'

/**
 * Alternate Bucket — self-hosted S3-compatible object storage.
 *
 * Image is built in the fork at github.com/alternatefutures/alternate-bucket
 * via `Dockerfile.brand` — wraps the upstream `rustfs/rustfs:1.0.0-beta.1`
 * binary on an Alpine base, with `scripts/entrypoint-brand.sh` translating
 * `ALTERNATE_BUCKET_*` env vars to the underlying binary's expected names
 * and stripping every `RustFS`/`rustfs` token from log/banner output. Users
 * never see the upstream brand.
 *
 * Tag `:v2` is the wrap-only build with Akash-aware entrypoint: the container
 * starts as root, chowns the persistent `/data` mount to uid 10001 (Akash
 * mounts persistent volumes root-owned, overlaying any build-time chown),
 * then drops to the unprivileged `alternate-bucket` user via `su-exec`.
 * Required because `:v1` crashed on Akash with `EACCES` on first write.
 *
 * A future `:vN-src` full-source-rebuild tag would have a binary with zero
 * `RustFS` bytes, but we're not building it yet — each QEMU iteration is
 * 30+ min and the wrap path covers our user-facing branding need.
 *
 * Ports:
 *   9000 → 9000   S3 API. Direct passthrough — sigv4 requires byte-exact
 *                  responses, so this port is NEVER proxied.
 *   9001 → 80     Branded web console, exposed via the AF subdomain proxy
 *                  on standard HTTPS so users get https://<slug>-app.<deploy-domain>.
 */
export const alternateBucket: Template = {
  id: 'alternate-bucket',
  name: 'Alternate Bucket',
  description:
    'Self-hosted, S3-compatible object storage with persistent volumes and a branded web console. Drops in anywhere an S3 SDK or CLI works.',
  featured: true,
  category: 'STORAGE',
  tags: [
    'storage',
    's3',
    'object-storage',
    'bucket',
    'self-hosted',
    'decentralized',
    'r2-compatible',
  ],
  icon: '/templates/alternate-bucket.svg',
  repoUrl: 'https://github.com/alternatefutures/alternate-bucket',
  dockerImage: 'ghcr.io/alternatefutures/alternate-bucket:v2',
  serviceType: 'BUCKET',
  envVars: [
    {
      key: 'ALTERNATE_BUCKET_ACCESS_KEY',
      default: null,
      description:
        'Root S3 access key ID (auto-generated at deploy time — visible in the deploy form, override to BYO credentials).',
      required: true,
      platformInjected: 'generatedAccessKey',
    },
    {
      key: 'ALTERNATE_BUCKET_SECRET_KEY',
      default: null,
      description:
        'Root S3 secret access key (auto-generated at deploy time — visible in the deploy form, override to BYO credentials).',
      required: true,
      secret: true,
      platformInjected: 'generatedSecret',
    },
    {
      key: 'ALTERNATE_BUCKET_OBS_LOGGER_LEVEL',
      default: 'info',
      description: 'Logger verbosity: error | warn | info | debug | trace',
      required: false,
    },
    {
      key: 'ALTERNATE_BUCKET_CORS_ALLOWED_ORIGINS',
      default: '*',
      description:
        'CORS allow-list for the S3 API. Use a comma-separated list of origins in production.',
      required: false,
    },
    {
      key: 'ALTERNATE_BUCKET_CONSOLE_CORS_ALLOWED_ORIGINS',
      default: '*',
      description:
        'CORS allow-list for the web console. Use a comma-separated list of origins in production.',
      required: false,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '1Gi',
    storage: '1Gi',
  },
  ports: [
    // Branded console (source-rebuilt image — no rebrand-proxy needed).
    // `as: 80` routes through the AF subdomain proxy on HTTPS.
    { port: 9001, as: 80, global: true },
    // S3 API — exposed directly on :9000 of the lease IP. Must NOT be
    // proxy-rewritten because sigv4 requires byte-exact responses.
    { port: 9000, as: 9000, global: true },
  ],
  persistentStorage: [
    {
      name: 'data',
      size: '10Gi',
      mountPath: '/data',
    },
  ],
  pricingUakt: 1500,
  akash: {
    chownPaths: ['/data'],
    runUser: 'alternate-bucket',
    runUid: 10001,
  },
  // Connection-string templates — consumed by ServiceLink env injection
  // when other services in the same project link to this bucket. `{{host}}`
  // and `{{port}}` resolve to the S3 API endpoint (the first/primary port
  // exposed by the lease's networking layer).
  connectionStrings: {
    AWS_ENDPOINT_URL_S3: 'http://{{host}}:{{port}}',
    S3_ENDPOINT: 'http://{{host}}:{{port}}',
    AWS_ACCESS_KEY_ID: '{{env.ALTERNATE_BUCKET_ACCESS_KEY}}',
    AWS_SECRET_ACCESS_KEY: '{{env.ALTERNATE_BUCKET_SECRET_KEY}}',
    AWS_REGION: 'auto',
    AWS_S3_FORCE_PATH_STYLE: 'true',
  },
}
