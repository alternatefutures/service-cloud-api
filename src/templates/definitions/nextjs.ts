import type { Template } from '../schema.js'

export const nextjsServer: Template = {
  id: 'nextjs-server',
  name: 'Next.js App',
  description:
    'Next.js 14 production server with App Router and SSR. Deploy your Next.js application with standalone output mode for minimal image size.',
  featured: true,
  category: 'WEB_SERVER',
  tags: ['web', 'nextjs', 'react', 'ssr', 'nodejs', 'frontend'],
  icon: '▲',
  repoUrl: 'https://github.com/vercel/next.js',
  dockerImage: 'node:22-alpine',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PORT',
      default: '3000',
      description: 'HTTP listen port',
      required: true,
    },
    {
      key: 'NODE_ENV',
      default: 'production',
      description: 'Node.js environment',
      required: true,
    },
    {
      key: 'NEXT_TELEMETRY_DISABLED',
      default: '1',
      description: 'Disable Next.js telemetry',
      required: false,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '512Mi',
    storage: '2Gi',
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
