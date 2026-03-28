import type { Template } from '../schema.js'

export const alternateAgent: Template = {
  id: 'alternate-agent',
  name: 'Alternate Agent',
  description:
    'Deploy an AI agent with chat UI, persistent memory, and pluggable connectors (Discord, Telegram, Slack). Uses AF integrated inference — no API keys needed.',
  featured: true,
  releaseStage: 'internal',
  category: 'AI_ML',
  tags: ['ai', 'agent', 'mastra', 'chatbot', 'discord', 'telegram'],
  icon: '🤖',
  repoUrl: 'https://github.com/alternatefutures/alternate-agent',
  dockerImage: 'ghcr.io/alternatefutures/alternate-agent:v1',
  serviceType: 'VM',
  envVars: [
    {
      key: 'AF_API_KEY',
      default: null,
      description: 'AlternateFutures PAT for AI inference billing',
      required: true,
      secret: true,
      platformInjected: 'apiKey',
    },
    {
      key: 'AF_ORG_ID',
      default: null,
      description: 'AlternateFutures organization ID for billing',
      required: true,
      platformInjected: 'orgId',
    },
    {
      key: 'MODEL_NAME',
      default: 'gpt-4o-mini',
      description: 'AI model (gpt-4o-mini, gpt-4o, claude-sonnet-4, grok-3, etc.)',
      required: false,
    },
    {
      key: 'AGENT_NAME',
      default: 'Alternate Agent',
      description: 'Agent display name',
      required: false,
    },
    {
      key: 'AGENT_INSTRUCTIONS',
      default: 'You are a helpful AI assistant.',
      description: 'System prompt / personality',
      required: false,
    },
    {
      key: 'DISCORD_BOT_TOKEN',
      default: null,
      description: 'Discord bot token (enables Discord connector)',
      required: false,
      secret: true,
    },
    {
      key: 'TELEGRAM_BOT_TOKEN',
      default: null,
      description: 'Telegram bot token (enables Telegram connector)',
      required: false,
      secret: true,
    },
    {
      key: 'AUTH_TOKEN',
      default: null,
      description: 'Optional Bearer token to protect the HTTP API',
      required: false,
      secret: true,
    },
  ],
  resources: {
    cpu: 1,
    memory: '1Gi',
    storage: '2Gi',
  },
  ports: [
    { port: 3000, as: 80, global: true },
  ],
  healthCheck: { path: '/health', port: 3000 },
  components: [
    {
      id: 'db',
      name: 'PostgreSQL + pgvector',
      internalOnly: true,
      inline: {
        dockerImage: 'pgvector/pgvector:pg17',
        resources: { cpu: 0.5, memory: '1Gi', storage: '1Gi' },
        ports: [{ port: 5432, as: 5432, global: true }],
        envVars: [
          { key: 'POSTGRES_DB', default: 'alternate_agent', description: 'Database name', required: true },
          { key: 'POSTGRES_USER', default: 'agent', description: 'Database user', required: true },
          { key: 'POSTGRES_PASSWORD', default: null, description: 'Database password', required: true, secret: true },
          { key: 'PGDATA', default: '/var/lib/postgresql/data/pgdata', description: 'Data directory', required: true },
        ],
        persistentStorage: [{ name: 'pgdata', size: '2Gi', mountPath: '/var/lib/postgresql/data' }],
        pricingUakt: 1500,
      },
    },
    {
      id: 'agent',
      name: 'Alternate Agent',
      primary: true,
      envLinks: {
        DATABASE_URL: 'postgresql://agent:{{generated.password}}@{{component.db.host}}:5432/alternate_agent',
      },
    },
  ],
}
