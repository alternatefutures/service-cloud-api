/**
 * Template System — public API
 */
export type {
  Template,
  TemplateCategory,
  TemplateCompanion,
  TemplateComponent,
  TemplateEnvVar,
  TemplateGpu,
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

export {
  generateSDLFromTemplate,
  generateCompositeSDL,
  resolveEnvLinks,
  slugify,
  generatePassword,
  generateBase64Secret,
} from './sdl.js'
export type { ResolvedComponent, CompositeContext } from './sdl.js'
export {
  generateComposeFromTemplate,
  generateComposeFromService,
  generateCompositeCompose,
  getEnvKeysFromTemplate,
} from './compose.js'
export type { RawServiceConfig } from './compose.js'