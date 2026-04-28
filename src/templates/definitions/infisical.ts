import type { Template } from '../schema.js'

/**
 * Infisical — self-hosted secrets management.
 *
 * 3-container deployment: Infisical app + PostgreSQL 15 + Redis 7.
 * customSdl is authoritative for this template; the top-level resources/ports
 * fields mirror the infisical service only (used by the CLI `info` command and
 * the UI template card).
 *
 * Placeholder mapping from the reference SDL (service-secrets/deploy-akash.yaml):
 *   ${ENCRYPTION_KEY}    → {{ENV.ENCRYPTION_KEY}}   (user-supplied, secret)
 *   ${AUTH_SECRET}       → {{ENV.AUTH_SECRET}}       (user-supplied, secret)
 *   ${POSTGRES_PASSWORD} → {{GENERATED_PASSWORD}}    (platform-generated, injected consistently)
 *   ${SMTP_PASSWORD}     → {{ENV.SMTP_PASSWORD}}     (user-supplied, secret)
 *   SITE_URL             → {{ENV.SITE_URL}}           (user-supplied, default provided)
 *   SMTP_* defaults      → {{ENV.SMTP_*}}             (user-editable with sane defaults)
 *   TELEMETRY_ENABLED    → {{ENV.TELEMETRY_ENABLED}} (default false)
 */
export const infisicalServer: Template = {
  id: 'infisical',
  name: 'Infisical',
  description:
    'Self-hosted secrets management — open-source alternative to AWS Secrets Manager / HashiCorp Vault. Stores API keys, DB passwords, certs with end-to-end encryption.',
  featured: false,
  category: 'DEVTOOLS',
  tags: ['secrets', 'security', 'devtools', 'infisical', 'vault'],
  icon: '🔐',
  repoUrl: 'https://github.com/Infisical/infisical',
  dockerImage: 'infisical/infisical:latest',
  serviceType: 'VM',
  resources: { cpu: 1, memory: '1Gi', storage: '512Mi' },
  ports: [{ port: 8080, as: 80, global: true }],
  healthCheck: { path: '/api/status', port: 8080 },
  pricingUakt: 55, // 20 (infisical) + 25 (postgres) + 10 (redis)

  envVars: [
    {
      key: 'ENCRYPTION_KEY',
      default: null,
      description:
        '32-character hex (16 bytes) for AES-128-GCM. Generate with `openssl rand -hex 16`.',
      required: true,
      secret: true,
    },
    {
      key: 'AUTH_SECRET',
      default: null,
      description:
        '32+ char base64 for JWT signing. Generate with `openssl rand -base64 32`.',
      required: true,
      secret: true,
    },
    {
      key: 'SMTP_PASSWORD',
      default: null,
      description:
        'SMTP password (Resend API key recommended, format `re_...`).',
      required: true,
      secret: true,
    },
    {
      key: 'SITE_URL',
      default: 'https://secrets.example.com',
      description: 'Public URL of this deployment (used in email links).',
      required: true,
    },
    {
      key: 'SMTP_HOST',
      default: 'smtp.resend.com',
      description: 'SMTP server hostname.',
      required: false,
    },
    {
      key: 'SMTP_PORT',
      default: '587',
      description: 'SMTP server port.',
      required: false,
    },
    {
      key: 'SMTP_USERNAME',
      default: 'resend',
      description: 'SMTP username.',
      required: false,
    },
    {
      key: 'SMTP_FROM_ADDRESS',
      default: 'noreply@example.com',
      description: 'From address for outbound email.',
      required: false,
    },
    {
      key: 'SMTP_FROM_NAME',
      default: 'Secrets',
      description: 'From display name for outbound email.',
      required: false,
    },
    {
      key: 'TELEMETRY_ENABLED',
      default: 'false',
      description: 'Send anonymous usage telemetry to Infisical.',
      required: false,
    },
  ],

  // POSTGRES_PASSWORD is platform-generated via {{GENERATED_PASSWORD}} and not
  // surfaced in the UI — it is injected consistently into both DB_CONNECTION_URI
  // (infisical service) and POSTGRES_PASSWORD (postgres service).
  customSdl: `---
version: "2.0"

services:
  infisical:
    image: infisical/infisical:latest
    env:
      - ENCRYPTION_KEY={{ENV.ENCRYPTION_KEY}}
      - AUTH_SECRET={{ENV.AUTH_SECRET}}
      - DB_CONNECTION_URI=postgres://infisical:{{GENERATED_PASSWORD}}@postgres:5432/infisical
      - REDIS_URL=redis://redis:6379
      - SITE_URL={{ENV.SITE_URL}}
      - TELEMETRY_ENABLED={{ENV.TELEMETRY_ENABLED}}
      - NEXT_PUBLIC_DISABLE_CSP=true
      - SMTP_HOST={{ENV.SMTP_HOST}}
      - SMTP_PORT={{ENV.SMTP_PORT}}
      - SMTP_USERNAME={{ENV.SMTP_USERNAME}}
      - SMTP_PASSWORD={{ENV.SMTP_PASSWORD}}
      - SMTP_FROM_ADDRESS={{ENV.SMTP_FROM_ADDRESS}}
      - SMTP_FROM_NAME={{ENV.SMTP_FROM_NAME}}
    expose:
      - port: 8080
        as: 80
        to:
          - global: true

  postgres:
    image: postgres:15-alpine
    env:
      - POSTGRES_USER=infisical
      - POSTGRES_PASSWORD={{GENERATED_PASSWORD}}
      - POSTGRES_DB=infisical
    expose:
      - port: 5432
        to:
          - service: infisical
    params:
      storage:
        pg-data:
          mount: /var/lib/postgresql/data
          readOnly: false

  redis:
    image: redis:7-alpine
    expose:
      - port: 6379
        to:
          - service: infisical

profiles:
  compute:
    infisical:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          - size: 512Mi

    postgres:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          - size: 1Gi
          - name: pg-data
            size: 10Gi
            attributes:
              persistent: true
              class: beta3

    redis:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 256Mi
        storage:
          - size: 512Mi

  placement:
    dcloud:
      pricing:
        infisical:
          denom: uakt
          amount: 20
        postgres:
          denom: uakt
          amount: 25
        redis:
          denom: uakt
          amount: 10

deployment:
  infisical:
    dcloud:
      profile: infisical
      count: 1
  postgres:
    dcloud:
      profile: postgres
      count: 1
  redis:
    dcloud:
      profile: redis
      count: 1
`,
}
