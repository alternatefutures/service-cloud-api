/**
 * Template Registry
 *
 * Static, code-defined registry of all available templates.
 * When we want user-created templates or a marketplace,
 * we'll add a Prisma model and query from DB here.
 */

import type { Template, TemplateCategory } from './schema.js'
import {
  nodeWsGameserver,
  bunWsGameserver,
  postgres,
  redis,
  milaidyGateway,
  openclawGateway,
  nanobotGateway,
  ollamaGpu,
  jupyterMlWorkspace,
  nextjsServer,
  reactVite,
  astroServer,
  nuxtServer,
  hugoServer,
  giteaServer,
  n8nServer,
  minecraftServer,
  comfyuiServer,
} from './definitions/index.js'

// ─── Registry ────────────────────────────────────────────────────

const templates: Template[] = [
  // AI / ML
  ollamaGpu,
  jupyterMlWorkspace,
  comfyuiServer,
  // Web Servers
  nextjsServer,
  reactVite,
  astroServer,
  nuxtServer,
  hugoServer,
  // Custom Gateways (AF platform)
  milaidyGateway,
  openclawGateway,
  nanobotGateway,
  // Game Servers
  nodeWsGameserver,
  bunWsGameserver,
  minecraftServer,
  // Databases
  postgres,
  redis,
  // DevTools
  giteaServer,
  n8nServer,
]

const templateMap = new Map<string, Template>(
  templates.map(t => [t.id, t])
)

// ─── Public API ──────────────────────────────────────────────────

/**
 * Get all available templates, optionally filtered by category.
 */
export function getAllTemplates(category?: TemplateCategory): Template[] {
  if (!category) return [...templates]
  return templates.filter(t => t.category === category)
}

/**
 * Get a single template by ID.
 */
export function getTemplateById(id: string): Template | undefined {
  return templateMap.get(id)
}

/**
 * Get templates matching any of the given tags.
 */
export function getTemplatesByTags(tags: string[]): Template[] {
  const tagSet = new Set(tags.map(t => t.toLowerCase()))
  return templates.filter(t =>
    t.tags.some(tag => tagSet.has(tag.toLowerCase()))
  )
}

/**
 * Get all unique categories that have at least one template.
 */
export function getAvailableCategories(): TemplateCategory[] {
  const cats = new Set<TemplateCategory>()
  for (const t of templates) {
    cats.add(t.category)
  }
  return [...cats]
}
