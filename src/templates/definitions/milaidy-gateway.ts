import type { Template } from '../schema.js'

export const milaidyGateway: Template = {
  id: 'milaidy-gateway',
  name: 'Milaidy',
  description:
    'Personal AI assistant gateway built on ElizaOS — web dashboard, multi-provider AI (Anthropic, OpenAI, Google, Ollama), plugin system, and WebSocket API.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'assistant', 'agent', 'elizaos', 'gateway', 'websocket'],
  icon: 'https://raw.githubusercontent.com/milady-ai/milaidy/develop/apps/landing/apple-touch-icon.png',
  repoUrl: 'https://github.com/milady-ai/milaidy',
  dockerImage: 'ghcr.io/alternatefutures/milaidy-akash:v7',
  serviceType: 'VM',
  envVars: [
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description: 'Anthropic API key for Claude models (recommended default provider)',
      required: false,
      secret: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description: 'OpenAI API key (optional — alternative or additional provider)',
      required: false,
      secret: true,
    },
    {
      key: 'GOOGLE_GENERATIVE_AI_API_KEY',
      default: null,
      description: 'Google Gemini API key (optional — alternative or additional provider)',
      required: false,
      secret: true,
    },
    {
      key: 'MILAIDY_STATE_DIR',
      default: '/home/node/.milaidy',
      description: 'Directory for agent state, config, plugins, and database files',
      required: true,
    },
    {
      key: 'MILAIDY_PORT',
      default: '2138',
      description: 'Port for the Milaidy dashboard + API server',
      required: true,
    },
  ],
  resources: {
    cpu: 1,
    memory: '1Gi',
    storage: '2Gi',
  },
  ports: [
    { port: 2138, as: 80, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'milaidy-state',
      size: '10Gi',
      mountPath: '/home/node/.milaidy',
    },
  ],
  pricingUakt: 2000,
  akash: {
    chownPaths: ['/home/node/.milaidy'],
    runUser: 'node',
    runUid: 1000,
  },
}
