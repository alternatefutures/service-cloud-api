/**
 * Template System — public API
 */
export type {
  Template,
  TemplateCategory,
  TemplateEnvVar,
  TemplateResources,
  TemplatePort,
  TemplateHealthCheck,
  TemplatePersistentStorage,
  TemplateDeployConfig,
} from './schema.js'

export {
  getAllTemplates,
  getTemplateById,
  getTemplatesByTags,
  getAvailableCategories,
} from './registry.js'

export { generateSDLFromTemplate } from './sdl.js'
