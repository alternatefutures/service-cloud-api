import type { Template } from '../schema.js'

export const reactVite: Template = {
  id: 'react-vite',
  name: 'React + Vite',
  description:
    'React SPA served by Nginx. Built with Vite for fast builds and hot module replacement. Perfect for client-side rendered applications.',
  featured: false,
  category: 'WEB_SERVER',
  tags: ['web', 'react', 'vite', 'spa', 'nginx', 'frontend'],
  icon: '⚡',
  repoUrl: 'https://github.com/vitejs/vite',
  dockerImage: 'nginx:1.27-alpine',
  serviceType: 'VM',
  envVars: [
    {
      key: 'NGINX_PORT',
      default: '80',
      description: 'Nginx listen port',
      required: true,
    },
  ],
  resources: {
    cpu: 0.25,
    memory: '256Mi',
    storage: '1Gi',
  },
  ports: [
    { port: 80, as: 80, global: true },
  ],
  healthCheck: {
    path: '/',
    port: 80,
  },
  pricingUakt: 400,
}
