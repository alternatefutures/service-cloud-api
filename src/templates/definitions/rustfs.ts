import type { Template } from '../schema.js'

/**
 * RustFS — self-hosted, S3-compatible object storage.
 *
 * Image is a thin wrapper around the official upstream
 * `rustfs/rustfs:1.0.0-beta.1` (see `service-cloud-api/docker/rustfs/Dockerfile`).
 * The wrapper layers our generic `akash-entrypoint` on top of upstream's own
 * `/entrypoint.sh` so the same image works on Akash (k8s root-owned PVCs need
 * a chown + privilege-drop dance) and on Phala / Spheron / local Docker (the
 * akash-entrypoint short-circuits when `AKASH_CHOWN_PATHS` is unset and execs
 * upstream's entrypoint directly).
 *
 * Zero rebranding — the binary, env-var names (`RUSTFS_*`), the console UI at
 * :9001, and the version string all come from upstream verbatim. Any future
 * upstream release is wrapped by bumping the tag in lockstep here and in the
 * Dockerfile FROM line.
 *
 * Ports:
 *   9000 → 9000   S3 API. Direct passthrough — sigv4 requires byte-exact
 *                  responses, so this port is NEVER proxied.
 *   9001 → 80     Web console, exposed via the AF subdomain proxy on standard
 *                  HTTPS so users get https://<slug>-app.<deploy-domain>.
 */
export const rustfs: Template = {
  id: 'rustfs',
  name: 'RustFS',
  description:
    'Self-hosted, S3-compatible object storage powered by RustFS, with persistent volumes and a web console. Drops in anywhere an S3 SDK or CLI works.',
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
    'rustfs',
  ],
  icon: '/templates/rustfs.svg',
  repoUrl: 'https://github.com/rustfs/rustfs',
  dockerImage: 'ghcr.io/alternatefutures/rustfs:1.0.0-beta.1',
  serviceType: 'BUCKET',
  envVars: [
    {
      key: 'RUSTFS_ACCESS_KEY',
      default: null,
      description:
        'Root S3 access key ID (auto-generated at deploy time — visible in the deploy form, override to BYO credentials).',
      required: true,
      platformInjected: 'generatedAccessKey',
    },
    {
      key: 'RUSTFS_SECRET_KEY',
      default: null,
      description:
        'Root S3 secret access key (auto-generated at deploy time — visible in the deploy form, override to BYO credentials).',
      required: true,
      secret: true,
      platformInjected: 'generatedSecret',
    },
    {
      key: 'RUSTFS_OBS_LOGGER_LEVEL',
      default: 'info',
      description: 'Logger verbosity: error | warn | info | debug | trace',
      required: false,
    },
    {
      key: 'RUSTFS_CORS_ALLOWED_ORIGINS',
      default: '*',
      description:
        'CORS allow-list for the S3 API. Use a comma-separated list of origins in production.',
      required: false,
    },
    {
      key: 'RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS',
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
    // Web console — `as: 80` routes through the AF subdomain proxy on HTTPS.
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
    // Akash mounts PVCs as root-owned; akash-entrypoint chowns these to the
    // run user before dropping privileges. Matches upstream's USER directive
    // (uid 10001, name `rustfs`) — the values are also baked into the image
    // ENV so the Dockerfile defaults align if no SDL env is present.
    chownPaths: ['/data', '/logs'],
    runUser: 'rustfs',
    runUid: 10001,
  },
  // Connection-string templates — consumed by ServiceLink env injection
  // when other services in the same project link to this bucket. `{{host}}`
  // and `{{port}}` resolve to the S3 API endpoint (the first/primary port
  // exposed by the lease's networking layer).
  connectionStrings: {
    AWS_ENDPOINT_URL_S3: 'http://{{host}}:{{port}}',
    S3_ENDPOINT: 'http://{{host}}:{{port}}',
    AWS_ACCESS_KEY_ID: '{{env.RUSTFS_ACCESS_KEY}}',
    AWS_SECRET_ACCESS_KEY: '{{env.RUSTFS_SECRET_KEY}}',
    AWS_REGION: 'auto',
    AWS_S3_FORCE_PATH_STYLE: 'true',
  },
}
