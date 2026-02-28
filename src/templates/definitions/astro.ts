import type { Template } from '../schema.js'

export const astroServer: Template = {
  id: 'astro-server',
  name: 'Astro',
  description:
    'Astro 4 with Node.js SSR adapter. Ship less JavaScript with Astro\'s island architecture. Ideal for content-heavy sites and blogs.',
  featured: false,
  category: 'WEB_SERVER',
  tags: ['web', 'astro', 'ssr', 'static', 'nodejs', 'frontend'],
  icon: '🚀',
  repoUrl: 'https://github.com/withastro/astro',
  dockerImage: 'node:22-alpine',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PORT',
      default: '4321',
      description: 'Astro server listen port',
      required: true,
    },
    {
      key: 'HOST',
      default: '0.0.0.0',
      description: 'Astro server listen host',
      required: true,
    },
  ],
  resources: {
    cpu: 0.25,
    memory: '256Mi',
    storage: '1Gi',
  },
  ports: [
    { port: 4321, as: 80, global: true },
  ],
  healthCheck: {
    path: '/',
    port: 4321,
  },
  pricingUakt: 400,
}
