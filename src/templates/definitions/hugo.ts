import type { Template } from '../schema.js'

export const hugoServer: Template = {
  id: 'hugo-server',
  name: 'Hugo',
  description:
    'Hugo static site generator served by Nginx. One of the fastest static site generators, with Markdown-driven content and theme support.',
  featured: false,
  category: 'WEB_SERVER',
  tags: ['web', 'hugo', 'static', 'blog', 'nginx', 'go'],
  icon: '📄',
  repoUrl: 'https://github.com/gohugoio/hugo',
  dockerImage: 'nginx:1.27-alpine',
  serviceType: 'VM',
  envVars: [],
  resources: {
    cpu: 0.25,
    memory: '128Mi',
    storage: '512Mi',
  },
  ports: [
    { port: 80, as: 80, global: true },
  ],
  healthCheck: {
    path: '/',
    port: 80,
  },
  pricingUakt: 300,
}
