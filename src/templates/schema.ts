/**
 * Template Type System
 *
 * Defines the structure of a deployable service template.
 * Templates are static TypeScript definitions (no DB needed).
 */

export type TemplateCategory =
  | 'GAME_SERVER'
  | 'WEB_SERVER'
  | 'DATABASE'
  | 'AI_ML'
  | 'DEVTOOLS'
  | 'CUSTOM'

export interface TemplateEnvVar {
  /** Environment variable key (e.g. "PORT") */
  key: string
  /** Default value (null = required, no default) */
  default: string | null
  /** Human-readable description */
  description: string
  /** Whether this var must be set before deploy */
  required: boolean
  /** If true, value is hidden in UI (for secrets) */
  secret?: boolean
  /**
   * When set, the deploy pipeline auto-injects this value.
   * The deploy UI pre-fills these fields (visible but auto-populated).
   *   'orgId'  — injects the deploying user's organization ID
   *   'apiKey' — generates a scoped PAT via service-auth
   */
  platformInjected?: 'orgId' | 'apiKey'
}

export interface TemplateGpu {
  /** Number of GPU units (e.g. 1) */
  units: number
  /** GPU vendor */
  vendor: 'nvidia'
  /** Specific model (e.g. "a100", "h100"). Omit for any available. */
  model?: string
}

export interface TemplateResources {
  /** CPU units (e.g. 0.5 = half a core) */
  cpu: number
  /** Memory with unit (e.g. "512Mi", "1Gi") */
  memory: string
  /** Ephemeral storage with unit (e.g. "1Gi") */
  storage: string
  /** Optional GPU allocation */
  gpu?: TemplateGpu
}

export interface TemplatePort {
  /** Container port */
  port: number
  /** Exposed port (for ingress) */
  as: number
  /** Whether port is exposed globally (via ingress) */
  global: boolean
}

export interface TemplateHealthCheck {
  /** Health check HTTP path */
  path: string
  /** Port to check against */
  port: number
}

export interface TemplatePersistentStorage {
  /** Volume name */
  name: string
  /** Size with unit (e.g. "10Gi") */
  size: string
  /** Mount path inside container */
  mountPath: string
}

export interface Template {
  /** Unique template identifier (e.g. "node-ws-gameserver") */
  id: string
  /** Human-readable name */
  name: string
  /** Short description (1-2 sentences) */
  description: string
  /** Whether this template should be highlighted in the UI */
  featured?: boolean
  /** Template category for filtering */
  category: TemplateCategory
  /** Searchable tags */
  tags: string[]
  /** Icon — emoji or URL */
  icon: string
  /** Public GitHub repo URL */
  repoUrl: string
  /** Docker image to deploy */
  dockerImage: string
  /** Maps to existing ServiceType enum (VM, FUNCTION, etc.) */
  serviceType: 'SITE' | 'FUNCTION' | 'VM' | 'DATABASE' | 'CRON' | 'BUCKET'
  /** Configurable environment variables with defaults */
  envVars: TemplateEnvVar[]
  /** Default resource allocation */
  resources: TemplateResources
  /** Exposed ports */
  ports: TemplatePort[]
  /** Optional health check endpoint */
  healthCheck?: TemplateHealthCheck
  /** Optional persistent storage volumes */
  persistentStorage?: TemplatePersistentStorage[]
  /** Akash pricing in uakt per block */
  pricingUakt?: number
  /** Start command override (if different from Dockerfile CMD) */
  startCommand?: string
  /** Akash-specific runtime config injected as env vars by the SDL generator */
  akash?: TemplateAkashConfig
  /**
   * Connection string templates for database-type services.
   * Keys become env var names on services that link to this one.
   * Values support {{host}}, {{port}}, {{env.KEY}} placeholders.
   */
  connectionStrings?: Record<string, string>
  /**
   * Raw Akash SDL that replaces auto-generation. Used for multi-service
   * templates (e.g. app + database sidecar). Supports placeholders:
   *   {{GENERATED_PASSWORD}} — random 32-char alphanumeric
   *   {{GENERATED_SECRET}}  — random 44-char base64
   *   {{SERVICE_NAME}}      — slugified service name
   * Env var overrides from the UI are still injected via injectPersistedEnvVars.
   */
  customSdl?: string
  /**
   * Companion services deployed alongside this template (e.g. a database).
   * Each companion creates a separate Service record in the workspace,
   * auto-linked via ServiceLink with connection string env var injection.
   * @deprecated Use `components` + `topologies` for new composite templates.
   */
  companions?: TemplateCompanion[]

  // ── Composable multi-service support ──────────────────────────
  /** Deployable sub-services (e.g. db, server, client) */
  components?: TemplateComponent[]
}

export interface TemplateCompanion {
  /** ID of an existing template to deploy as companion (e.g. "postgres") */
  templateId: string
  /** Display name prefix for the companion service (e.g. "hyperscape-db") */
  namePrefix?: string
  /** Pre-filled env var defaults for the companion (e.g. { POSTGRES_DB: "hyperscape" }) */
  envDefaults?: Record<string, string>
  /** Auto-create ServiceLink and inject connectionStrings on deploy */
  autoLink: boolean
}

export interface TemplateAkashConfig {
  /** Paths to chown at boot (so non-root user can write persistent volumes) */
  chownPaths?: string[]
  /** Username to drop privileges to after chown */
  runUser?: string
  /** UID of the run user (for chown) */
  runUid?: number
}

// ─── Composable Template System ─────────────────────────────────

/**
 * A deployable component within a composite template.
 * Source is exactly one of: `primary` (parent template), `templateId`
 * (reference), or `inline` (self-contained definition).
 */
export interface TemplateComponent {
  /** Unique within this template (e.g. 'db', 'server', 'client') */
  id: string
  /** Display name (e.g. 'PostgreSQL Database') */
  name: string
  description?: string

  // ── Source (exactly one) ──────────────────────────────────────
  /** Use parent template's dockerImage/resources/ports/envVars/etc. */
  primary?: boolean
  /** Reference an existing template by ID (e.g. 'postgres') */
  templateId?: string
  /** Fully inline component definition */
  inline?: {
    dockerImage: string
    resources: TemplateResources
    ports?: TemplatePort[]
    envVars?: TemplateEnvVar[]
    persistentStorage?: TemplatePersistentStorage[]
    healthCheck?: TemplateHealthCheck
    startCommand?: string
    akash?: TemplateAkashConfig
    connectionStrings?: Record<string, string>
    pricingUakt?: number
  }

  // ── Availability ────────────────────────────────────────────────
  /** Whether this component must be deployed (default: true).
   *  Primary and internalOnly components are always implicitly required. */
  required?: boolean
  /** When this component is disabled, these values replace references to it
   *  in other components' envLinks. Keys map to field names used in placeholders:
   *  'proxyHttpUrl', 'proxyWsUrl', 'proxyUrl', 'host', 'env.SOME_KEY' */
  fallbacks?: Record<string, string>

  // ── Behavior ──────────────────────────────────────────────────
  /** Don't expose ports globally — internal-only (e.g. databases) */
  internalOnly?: boolean
  /** Override the Akash SDL service name (default: component id) */
  sdlServiceName?: string
  /** Pre-fill env vars when source is `templateId` */
  envDefaults?: Record<string, string>
  /** Override start command (wraps or replaces the source template's CMD) */
  startCommand?: string

  // ── Cross-component env var linking ───────────────────────────
  /**
   * Env vars resolved at deploy time and injected on this component.
   * Supports placeholders:
   *   {{component.<id>.host}}       — internal hostname (same lease) or AF proxy URL
   *   {{component.<id>.proxyUrl}}   — always the AF proxy URL
   *   {{component.<id>.env.<KEY>}}  — resolved env var value from that component
   *   {{generated.password}}         — random 32-char password (same everywhere)
   *   {{generated.secret}}           — random base64 secret (same everywhere)
   */
  envLinks?: Record<string, string>
}

export interface TopologyTarget {
  /** Which component this target refers to */
  componentId: string
  /** Which provider deploys this component */
  provider: 'akash' | 'phala'
  /** Components with the same group share a lease (Akash) or co-deploy (Phala) */
  group: string
}

/**
 * A pre-configured deployment arrangement — maps components to providers.
 */
export interface DeploymentTopology {
  id: string
  name: string
  description: string
  targets: TopologyTarget[]
}

/**
 * User-provided configuration overrides when deploying a template.
 */
export interface TemplateDeployConfig {
  /** Override service name (default: auto-generated from template) */
  serviceName?: string
  /** Override environment variable values */
  envOverrides?: Record<string, string>
  /** Override resource allocation (gpu: null to explicitly disable) */
  resourceOverrides?: {
    cpu?: number
    memory?: string
    storage?: string
    gpu?: TemplateGpu | null
  }
  /** Akash deposit in uakt */
  depositUakt?: number
}
