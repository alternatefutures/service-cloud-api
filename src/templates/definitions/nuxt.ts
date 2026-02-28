import type { Template } from '../schema.js'

export const nuxtServer: Template = {
  id: 'nuxt-server',
  name: 'Vue / Nuxt',
  description:
    'Nuxt 3 with server-side rendering and Vue 3 Composition API. Full-stack Vue framework with automatic code splitting and SEO-friendly SSR.',
  featured: false,
  category: 'WEB_SERVER',
  tags: ['web', 'vue', 'nuxt', 'ssr', 'nodejs', 'frontend'],
  icon: '💚',
  repoUrl: 'https://github.com/nuxt/nuxt',
  dockerImage: 'node:22-alpine',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PORT',
      default: '3000',
      description: 'Nuxt server listen port',
      required: true,
    },
    {
      key: 'HOST',
      default: '0.0.0.0',
      description: 'Nuxt server listen host',
      required: true,
    },
    {
      key: 'NODE_ENV',
      default: 'production',
      description: 'Node.js environment',
      required: true,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '512Mi',
    storage: '1Gi',
  },
  ports: [
    { port: 3000, as: 80, global: true },
  ],
  healthCheck: {
    path: '/',
    port: 3000,
  },
  pricingUakt: 800,
}
