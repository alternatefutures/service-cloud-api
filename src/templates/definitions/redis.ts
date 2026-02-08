import type { Template } from '../schema.js'

export const redis: Template = {
  id: 'redis',
  name: 'Redis',
  description:
    'Redis 7 Alpine — in-memory data store for caching, sessions, pub/sub, and rate limiting. Optional persistent storage.',
  category: 'DATABASE',
  tags: ['database', 'cache', 'redis', 'nosql', 'pubsub'],
  icon: '🔴',
  repoUrl: 'https://hub.docker.com/_/redis',
  dockerImage: 'redis:7-alpine',
  serviceType: 'DATABASE',
  envVars: [
    {
      key: 'REDIS_ARGS',
      default: '--save 60 1 --loglevel warning',
      description: 'Additional Redis server arguments',
      required: false,
    },
  ],
  resources: {
    cpu: 0.25,
    memory: '256Mi',
    storage: '1Gi',
  },
  ports: [
    { port: 6379, as: 6379, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'redisdata',
      size: '5Gi',
      mountPath: '/data',
    },
  ],
  pricingUakt: 500,
  startCommand: 'redis-server',
}
