import type { Template } from '../schema.js'

/**
 * Alternate Agent — Mastra-based AI agent template.
 *
 * Three modes (any combination, all driven by env):
 *   1. Chat agent          — built-in chat UI at the deployment URL.
 *   2. Connector agent     — Discord bot, X (Twitter) auto-management,
 *                            etc. Activated by setting the relevant token env.
 *   3. Autonomous goal loop — set AGENT_GOAL and the agent runs a periodic
 *                              tick (~AUTONOMOUS_INTERVAL_MIN, ±20% jitter)
 *                              where it can read X mentions/timeline, query
 *                              Supabase RAG, generate images/videos, and post.
 *
 * Supabase RAG: optional. If SUPABASE_URL + SUPABASE_KEY are set, the agent
 * gets a `query_knowledge_base` tool that calls the user's existing
 * Supabase pgvector via an RPC (default name `match_documents`). This is
 * separate from Mastra's built-in conversation memory (which uses the
 * companion pgvector below) — RAG is for the user's own KB, Mastra
 * memory is for chat history.
 *
 * Image/video generation: routed through AF inference proxy via fal.ai.
 * No separate API keys; same wallet as chat inference.
 *
 * X anti-automation: cookie-based auth (TWITTER_COOKIES) is strongly
 * preferred over username/password. X frequently challenges new password
 * logins with arkose/captcha that the agent cannot solve.
 */
export const alternateAgent: Template = {
  id: 'alternate-agent',
  name: 'Alternate Agent',
  description:
    'AI agent with chat UI, persistent memory, autonomous goal loop, and pluggable connectors (Discord, X/Twitter). Native Supabase RAG + image/video generation through AF inference. No separate API keys — uses your AF wallet.',
  featured: true,
  category: 'AI_ML',
  tags: [
    'ai',
    'agent',
    'mastra',
    'autonomous',
    'rag',
    'supabase',
    'x',
    'twitter',
    'social',
    'chatbot',
    'discord',
  ],
  icon: '🤖',
  repoUrl: 'https://github.com/alternatefutures/alternate-agent',
  dockerImage: 'ghcr.io/alternatefutures/alternate-agent:v2',
  serviceType: 'VM',
  envVars: [
    // ── Required: AF inference billing ──
    {
      key: 'AF_API_KEY',
      default: null,
      description: 'Alternate Clouds PAT — funds chat, image, and video inference.',
      required: true,
      secret: true,
      platformInjected: 'apiKey',
    },
    {
      key: 'AF_ORG_ID',
      default: null,
      description: 'Alternate Clouds organization ID (for billing).',
      required: true,
      platformInjected: 'orgId',
    },
    // ── Model + persona ──
    {
      key: 'MODEL_NAME',
      default: 'gpt-4o-mini',
      description: 'Chat model (e.g. gpt-4o-mini, gpt-4o, claude-sonnet-4, grok-3).',
      required: false,
    },
    {
      key: 'AGENT_NAME',
      default: 'Alternate Agent',
      description: 'Agent display name shown in chat UI and bot identity.',
      required: false,
    },
    {
      key: 'AGENT_INSTRUCTIONS',
      default: 'You are a helpful AI assistant.',
      description: 'System prompt / personality. Use this to set tone, voice, constraints.',
      required: false,
    },
    // ── Autonomous goal mode ──
    {
      key: 'AGENT_GOAL',
      default: null,
      description:
        'Sets the agent to autonomous mode. Free-form description of what the agent ' +
        'should pursue every tick (e.g. "Grow @myproject on X by sharing project updates ' +
        'and replying to mentions, grounded in the project KB"). Leave blank for chat-only.',
      required: false,
    },
    {
      key: 'AUTONOMOUS_INTERVAL_MIN',
      default: '30',
      description: 'Minutes between autonomous ticks (5-1440). ±20% jitter applied.',
      required: false,
    },
    // ── Supabase RAG (optional but recommended for grounded posts) ──
    {
      key: 'SUPABASE_URL',
      default: null,
      description:
        'Your Supabase project URL (e.g. https://xxx.supabase.co). Enables the ' +
        'query_knowledge_base tool for RAG over your existing vector store.',
      required: false,
    },
    {
      key: 'SUPABASE_KEY',
      default: null,
      description:
        'Supabase service role or anon key. Service role recommended so the agent can ' +
        'call the RPC even if you have RLS enabled.',
      required: false,
      secret: true,
    },
    {
      key: 'SUPABASE_RPC_NAME',
      default: 'match_documents',
      description:
        'Name of the Supabase RPC for vector similarity search. Default matches the ' +
        'standard Supabase pgvector quickstart. Function signature: ' +
        '(query text, match_count int) returns table(content text, similarity float).',
      required: false,
    },
    // ── X (Twitter) — cookie auth strongly preferred ──
    {
      key: 'TWITTER_COOKIES',
      default: null,
      description:
        'X session cookies as JSON (recommended). Capture from a logged-in browser session. ' +
        'Survives X anti-automation far better than password login. ' +
        'Format: array of cookie strings or cookie objects.',
      required: false,
      secret: true,
    },
    {
      key: 'TWITTER_USERNAME',
      default: null,
      description: 'X handle (without @). Fallback if TWITTER_COOKIES is not set.',
      required: false,
    },
    {
      key: 'TWITTER_PASSWORD',
      default: null,
      description: 'X password. Triggers password login (fragile; X often challenges with captcha).',
      required: false,
      secret: true,
    },
    {
      key: 'TWITTER_EMAIL',
      default: null,
      description: 'X account email. Sometimes required by the password login flow.',
      required: false,
    },
    // ── Other connectors ──
    {
      key: 'DISCORD_BOT_TOKEN',
      default: null,
      description: 'Discord bot token — enables the Discord connector for chat in servers.',
      required: false,
      secret: true,
    },
    // ── Optional: model overrides for media generation ──
    {
      key: 'IMAGE_GEN_MODEL',
      default: 'fal-ai/flux/schnell',
      description:
        'fal.ai image model path. Default is cheap & fast (~$0.003/image). ' +
        'Try fal-ai/flux/dev or fal-ai/imagen3 for higher quality.',
      required: false,
    },
    {
      key: 'VIDEO_GEN_MODEL',
      default: 'fal-ai/veo3/fast',
      description:
        'fal.ai video model path. EXPENSIVE per call (~$0.50+). Set conservative ' +
        'maxBudgetUsd in deployment policy to cap blast radius.',
      required: false,
    },
    // ── HTTP API protection ──
    {
      key: 'AUTH_TOKEN',
      default: null,
      description: 'Optional Bearer token to protect the HTTP API at /api/*.',
      required: false,
      secret: true,
    },
  ],
  resources: {
    // Bumped from 1cpu/1Gi/2Gi — autonomous loop + media tools want a bit more headroom.
    cpu: 1,
    memory: '2Gi',
    storage: '2Gi',
  },
  ports: [{ port: 3000, as: 80, global: true }],
  healthCheck: { path: '/health', port: 3000 },
  // Persistent volume for the X session cookies + Mastra working memory cache.
  // Without this, every restart re-logs into X — which trips anti-automation
  // because re-login from a "new" container is exactly what bots do.
  persistentStorage: [
    {
      name: 'agent-data',
      size: '5Gi',
      mountPath: '/app/data',
    },
  ],
  pricingUakt: 2000,
  akash: {
    chownPaths: ['/app/data'],
    runUser: 'node',
    runUid: 1000,
  },
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
