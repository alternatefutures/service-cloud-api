import type { Template } from '../schema.js'

/**
 * OpenClaw (Clawd Bot) Gateway
 *
 * Based on OpenClaw's official Docker compose defaults:
 * - UI/gateway port: 18789
 * - Bridge port: 18790
 * - State dir: ~/.openclaw (persist this)
 *
 * Docs:
 * - https://docs.clawd.bot/install/docker
 * - https://docs.clawd.bot/gateway/authentication
 */
export const openclawGateway: Template = {
  id: 'openclaw-gateway',
  name: 'Clawd Bot (OpenClaw)',
  description:
    'Personal AI assistant gateway (OpenClaw/Clawd Bot) with Control UI, multi-provider models, channels, and optional sandboxed tools.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'assistant', 'agent', 'openclaw', 'clawd', 'gateway'],
  // Emoji here so frontend can render a consistent react-icon.
  icon: '🦞',
  repoUrl: 'https://github.com/openclaw/openclaw',
  // Public Docker Hub mirror (official source is ghcr.io/openclaw/openclaw)
  dockerImage: 'alpine/openclaw:main',
  serviceType: 'VM',
  envVars: [
    // Gateway access control
    {
      key: 'OPENCLAW_GATEWAY_TOKEN',
      default: null,
      description: 'Control UI token (recommended) — used to authenticate dashboard/control UI access',
      required: true,
      secret: true,
    },
    {
      key: 'OPENCLAW_GATEWAY_PASSWORD',
      default: null,
      description: 'Alternative to token auth — password for Control UI access',
      required: false,
      secret: true,
    },

    // Model provider keys (API key path recommended in docs)
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description: 'Anthropic API key for Claude models (recommended)',
      required: false,
      secret: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description: 'OpenAI API key (optional provider)',
      required: false,
      secret: true,
    },
    {
      key: 'GOOGLE_GENERATIVE_AI_API_KEY',
      default: null,
      description: 'Google Gemini API key (optional provider)',
      required: false,
      secret: true,
    },

    // Claude subscription cookie auth (optional; advanced)
    {
      key: 'CLAUDE_AI_SESSION_KEY',
      default: null,
      description: 'Claude subscription session key (advanced; optional)',
      required: false,
      secret: true,
    },
    {
      key: 'CLAUDE_WEB_SESSION_KEY',
      default: null,
      description: 'Claude web session key (advanced; optional)',
      required: false,
      secret: true,
    },
    {
      key: 'CLAUDE_WEB_COOKIE',
      default: null,
      description: 'Claude web cookie (advanced; optional)',
      required: false,
      secret: true,
    },

    // State dir (persisted volume below)
    {
      key: 'OPENCLAW_STATE_DIR',
      default: '/home/node/.openclaw',
      description: 'Directory for OpenClaw config, agent state, and workspace',
      required: true,
    },
  ],
  resources: {
    cpu: 1,
    memory: '1Gi',
    storage: '2Gi',
  },
  ports: [
    // Map gateway UI to HTTP 80 for nicer URLs
    { port: 18789, as: 80, global: true },
    // Bridge port (kept as-is)
    { port: 18790, as: 18790, global: true },
  ],
  healthCheck: undefined,
  persistentStorage: [
    {
      name: 'openclaw-state',
      size: '10Gi',
      mountPath: '/home/node/.openclaw',
    },
  ],
  pricingUakt: 2500,
  // Docker defaults bind to loopback; for cloud deployments we need LAN bind.
  startCommand: 'node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured',
}

