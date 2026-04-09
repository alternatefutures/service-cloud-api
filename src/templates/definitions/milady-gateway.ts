import type { Template } from '../schema.js'

export const miladyGateway: Template = {
  id: 'milady-gateway',
  name: 'Milady',
  description:
    'Personal AI assistant built on ElizaOS — self-hosted dashboard, multi-provider AI, plugin system, and WebSocket API.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'assistant', 'agent', 'elizaos', 'gateway', 'websocket'],
  // Keep the existing icon asset path until the asset itself is renamed.
  icon: '/templates/milaidy.png',
  repoUrl: 'https://github.com/milady-ai/milady',
  dockerImage: 'ghcr.io/alternatefutures/milady:v9',
  serviceType: 'VM',
  envVars: [],
  resources: {
    cpu: 2,
    memory: '4Gi',
    storage: '5Gi',
  },
  ports: [
    { port: 2138, as: 80, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'milady-state',
      size: '10Gi',
      mountPath: '/home/node/.milady',
    },
  ],
  pricingUakt: 2000,
  akash: {
    chownPaths: ['/home/node/.milady'],
    runUser: 'node',
    runUid: 1000,
  },
}
