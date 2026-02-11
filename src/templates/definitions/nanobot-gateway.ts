import type { Template } from '../schema.js'

/**
 * nanobot Gateway
 *
 * Ultra-lightweight personal AI assistant (~4k lines) inspired by OpenClaw.
 * - CLI agent + gateway for Telegram, Discord, WhatsApp, Slack, Email, etc.
 * - Multi-provider: OpenRouter, Anthropic, OpenAI, DeepSeek, Groq, vLLM
 * - No web UI; access via CLI or chat channels
 *
 * Docs: https://github.com/HKUDS/nanobot
 */
export const nanobotGateway: Template = {
  id: 'nanobot-gateway',
  name: 'nanobot',
  description:
    'Ultra-lightweight personal AI assistant (~4k lines). Multi-provider (OpenRouter, Claude, GPT), CLI + chat channels (Telegram, Discord, Slack). No web UI.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'assistant', 'agent', 'nanobot', 'openclaw', 'gateway', 'lightweight'],
  icon: '🐈',
  repoUrl: 'https://github.com/HKUDS/nanobot',
  // Wrapper image: generates config from env, runs nanobot gateway
  dockerImage: 'ghcr.io/alternatefutures/nanobot-akash:v2',
  serviceType: 'VM',
  envVars: [
    {
      key: 'OPENROUTER_API_KEY',
      default: null,
      description: 'OpenRouter API key (recommended — access to all models). Required: nanobot exits without at least one LLM key.',
      required: true,
      secret: true,
    },
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description: 'Anthropic API key for Claude models',
      required: false,
      secret: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description: 'OpenAI API key for GPT models',
      required: false,
      secret: true,
    },
    {
      key: 'DEEPSEEK_API_KEY',
      default: null,
      description: 'DeepSeek API key (optional)',
      required: false,
      secret: true,
    },
    {
      key: 'GROQ_API_KEY',
      default: null,
      description: 'Groq API key (optional — also enables Whisper voice transcription)',
      required: false,
      secret: true,
    },
    {
      key: 'NANOBOT_DEFAULT_MODEL',
      default: 'anthropic/claude-opus-4-5',
      description: 'Default LLM model (e.g. anthropic/claude-opus-4-5, openrouter/...)',
      required: true,
    },
    {
      key: 'NANOBOT_STATE_DIR',
      default: '/home/nanobot/.nanobot',
      description: 'Directory for config, workspace, and session data',
      required: true,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '1Gi',
    storage: '2Gi',
  },
  ports: [
    { port: 18790, as: 80, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'nanobot-state',
      size: '10Gi',
      mountPath: '/home/nanobot/.nanobot',
    },
  ],
  pricingUakt: 1500,
  // No startCommand — wrapper entrypoint runs nanobot gateway
}
