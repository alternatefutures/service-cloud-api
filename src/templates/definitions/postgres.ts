import type { Template } from '../schema.js'

export const postgres: Template = {
  id: 'postgres',
  name: 'PostgreSQL',
  description:
    'PostgreSQL 16 Alpine — lightweight, production-ready relational database with persistent storage.',
  category: 'DATABASE',
  tags: ['database', 'sql', 'postgres', 'relational'],
  icon: '🐘',
  repoUrl: 'https://hub.docker.com/_/postgres',
  dockerImage: 'postgres:16-alpine',
  serviceType: 'DATABASE',
  envVars: [
    {
      key: 'POSTGRES_DB',
      default: 'appdb',
      description: 'Default database name',
      required: true,
    },
    {
      key: 'POSTGRES_USER',
      default: 'postgres',
      description: 'Database superuser name',
      required: true,
    },
    {
      key: 'POSTGRES_PASSWORD',
      default: null,
      description: 'Database superuser password',
      required: true,
      secret: true,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '1Gi',
    storage: '1Gi',
  },
  ports: [
    { port: 5432, as: 5432, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'pgdata',
      size: '10Gi',
      mountPath: '/var/lib/postgresql/data',
    },
  ],
  pricingUakt: 1500,
}
