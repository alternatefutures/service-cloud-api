import type { Template } from '../schema.js'

export const n8nServer: Template = {
  id: 'n8n',
  name: 'n8n',
  description:
    'Workflow automation platform — the open-source alternative to Zapier. Connect 400+ apps with a visual editor, code nodes, and AI-powered automations.',
  featured: true,
  category: 'DEVTOOLS',
  tags: ['automation', 'workflow', 'devtools', 'n8n', 'no-code', 'integration'],
  icon: '🔗',
  repoUrl: 'https://github.com/n8n-io/n8n',
  dockerImage: 'n8nio/n8n:1.93.0',
  serviceType: 'VM',
  envVars: [
    {
      key: 'N8N_HOST',
      default: '0.0.0.0',
      description: 'n8n server listen host',
      required: true,
    },
    {
      key: 'N8N_PORT',
      default: '5678',
      description: 'n8n server listen port',
      required: true,
    },
    {
      key: 'N8N_PROTOCOL',
      default: 'https',
      description: 'Protocol used for webhooks (http or https)',
      required: true,
    },
    {
      key: 'WEBHOOK_URL',
      default: null,
      description: 'Public URL for incoming webhooks (set to your deployed URL)',
      required: true,
    },
    {
      key: 'N8N_ENCRYPTION_KEY',
      default: null,
      description: 'Encryption key for stored credentials (generate a random 32-char string)',
      required: true,
      secret: true,
    },
    {
      key: 'GENERIC_TIMEZONE',
      default: 'UTC',
      description: 'Default timezone for scheduled workflows',
      required: false,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '1Gi',
    storage: '2Gi',
  },
  ports: [
    { port: 5678, as: 80, global: true },
  ],
  healthCheck: {
    path: '/healthz',
    port: 5678,
  },
  persistentStorage: [
    {
      name: 'n8n-data',
      size: '10Gi',
      mountPath: '/home/node/.n8n',
    },
  ],
  pricingUakt: 2000,
}
