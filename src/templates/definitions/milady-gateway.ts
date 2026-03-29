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
  dockerImage: 'ghcr.io/alternatefutures/milady:v6',
  serviceType: 'VM',
  envVars: [
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description: 'Optional Anthropic API key for Claude models. Can also be configured later in the Milady UI.',
      required: false,
      secret: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description: 'Optional OpenAI API key. Can also be configured later in the Milady UI.',
      required: false,
      secret: true,
    },
    {
      key: 'GOOGLE_GENERATIVE_AI_API_KEY',
      default: null,
      description: 'Optional Google Gemini API key. Can also be configured later in the Milady UI.',
      required: false,
      secret: true,
    },
    {
      key: 'OPENROUTER_API_KEY',
      default: null,
      description: 'Optional OpenRouter API key for access to many models through one provider.',
      required: false,
      secret: true,
    },
    {
      key: 'GROQ_API_KEY',
      default: null,
      description: 'Optional Groq API key for fast hosted inference.',
      required: false,
      secret: true,
    },
    {
      key: 'XAI_API_KEY',
      default: null,
      description: 'Optional xAI API key for Grok models.',
      required: false,
      secret: true,
    },
    {
      key: 'DEEPSEEK_API_KEY',
      default: null,
      description: 'Optional DeepSeek API key for reasoning and coding models.',
      required: false,
      secret: true,
    },
    {
      key: 'MILADY_API_TOKEN',
      default: null,
      description:
        'Recommended for public deployments. Stable access key for API and WebSocket auth instead of a temporary token generated at boot.',
      required: false,
      secret: true,
    },
    {
      key: 'MILADY_ALLOWED_ORIGINS',
      default: null,
      description:
        'Optional comma-separated CORS allowlist for remote/browser clients. Leave empty for the built-in same-origin dashboard.',
      required: false,
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
