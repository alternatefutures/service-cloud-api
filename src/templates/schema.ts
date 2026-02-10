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
}

export interface TemplateResources {
  /** CPU units (e.g. 0.5 = half a core) */
  cpu: number
  /** Memory with unit (e.g. "512Mi", "1Gi") */
  memory: string
  /** Ephemeral storage with unit (e.g. "1Gi") */
  storage: string
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
}

/**
 * User-provided configuration overrides when deploying a template.
 */
export interface TemplateDeployConfig {
  /** Override service name (default: auto-generated from template) */
  serviceName?: string
  /** Override environment variable values */
  envOverrides?: Record<string, string>
  /** Override resource allocation */
  resourceOverrides?: Partial<TemplateResources>
  /** Akash deposit in uakt */
  depositUakt?: number
}
