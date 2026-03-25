import type { Template } from '../schema.js'

export const hyperscapeServer: Template = {
  id: 'hyperscape',
  name: 'Hyperscape',
  description:
    'AI-native MMORPG duel arena with real-time combat, physics (PhysX WASM), ElizaOS AI agents, and WebSocket architecture. Deploys game server (with embedded web client) and PostgreSQL.',
  featured: true,
  category: 'GAME_SERVER',
  tags: [
    'game',
    'mmorpg',
    'rpg',
    'multiplayer',
    'websocket',
    'ai',
    'agents',
    'metaverse',
    'tee',
    'duel-arena',
  ],
  icon: '/templates/hyperscape.png',
  repoUrl: 'https://github.com/HyperscapeAI/hyperscape',
  dockerImage: 'ghcr.io/alternatefutures/hyperscape:v12',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PUBLIC_CDN_URL',
      default: '',
      description:
        'CDN base URL for game assets (models, textures, audio). Auto-resolved from the assets component in composite deployments.',
      required: false,
    },
    {
      key: 'PUBLIC_PRIVY_APP_ID',
      default: null,
      description:
        'Privy application ID for wallet-based authentication (must match client)',
      required: false,
    },
    {
      key: 'PRIVY_APP_SECRET',
      default: null,
      description:
        'Privy application secret for server-side token verification',
      required: false,
      secret: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description:
        'OpenAI API key for AI agents (optional — enables LLM-powered NPCs)',
      required: false,
      secret: true,
    },
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description:
        'Anthropic API key for AI agents (optional alternative provider)',
      required: false,
      secret: true,
    },
    {
      key: 'ADMIN_CODE',
      default: null,
      description: 'In-game admin access code (type /admin <code> in chat)',
      required: false,
      secret: true,
    },
    {
      key: 'SAVE_INTERVAL',
      default: '60',
      description: 'Auto-save interval in seconds for player/world state',
      required: false,
    },
  ],
  resources: {
    cpu: 2,
    memory: '4Gi',
    storage: '4Gi',
  },
  ports: [{ port: 5555, as: 80, global: true }],
  healthCheck: {
    path: '/status',
    port: 5555,
  },
  persistentStorage: [
    {
      name: 'hyperscape-data',
      size: '4Gi',
      mountPath: '/app/data',
    },
  ],
  pricingUakt: 4000,

  // ── Composable multi-service deployment ─────────────────────

  components: [
    {
      id: 'db',
      name: 'PostgreSQL Database',
      templateId: 'postgres',
      internalOnly: true,
      sdlServiceName: 'postgres',
      envDefaults: {
        POSTGRES_DB: 'hyperscape',
        POSTGRES_USER: 'hyperscape',
      },
    },
    {
      id: 'server',
      name: 'Game Server',
      primary: true,
      sdlServiceName: 'app',
      startCommand: [
        'if [ -n "$POSTGRES_SERVICE_HOST" ]; then',
        '  export DATABASE_URL=$(echo "$DATABASE_URL" | sed "s/@postgres:/@${POSTGRES_SERVICE_HOST}:/")',
        '  echo "Resolved postgres -> $POSTGRES_SERVICE_HOST via K8s service discovery"',
        'fi',
        'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
        '  curl -so /dev/null --connect-timeout 2 http://${POSTGRES_SERVICE_HOST:-postgres}:5432/ 2>/dev/null',
        '  rc=$?; [ $rc -ne 6 ] && [ $rc -ne 7 ] && break',
        '  echo "Waiting for postgres ($i/15)..."',
        '  sleep 2',
        'done',
        'exec bun --preload /app/packages/server/src/shared/polyfills.ts /app/packages/server/dist/index.js',
      ].join('\n'),
      envLinks: {
        DATABASE_URL:
          'postgresql://{{component.db.env.POSTGRES_USER}}:{{generated.password}}@{{component.db.host}}:5432/{{component.db.env.POSTGRES_DB}}',
        JWT_SECRET: '{{generated.secret}}',
        ARENA_EXTERNAL_BET_WRITE_KEY: '{{generated.secret}}',
        PORT: '5555',
        NODE_ENV: 'production',
        USE_LOCAL_POSTGRES: 'false',
        PUBLIC_API_URL: '{{component.server.proxyHttpUrl}}',
        PUBLIC_WS_URL: '{{component.server.proxyWsUrl}}/ws',
        PUBLIC_CDN_URL: '{{component.assets.proxyHttpUrl}}',
        PUBLIC_APP_URL: '{{component.client.proxyHttpUrl}}',
      },
    },
    {
      id: 'assets',
      name: 'Asset Server',
      description:
        'Caddy static file server hosting game assets (models, textures, audio). Disable if you have your own CDN and set PUBLIC_CDN_URL manually.',
      required: false,
      fallbacks: {
        proxyHttpUrl: '',
      },
      sdlServiceName: 'assets',
      inline: {
        dockerImage: 'ghcr.io/alternatefutures/hyperscape-assets:v1',
        resources: { cpu: 0.5, memory: '256Mi', storage: '8Gi' },
        ports: [{ port: 80, as: 80, global: true }],
        healthCheck: { path: '/', port: 80 },
        pricingUakt: 1000,
      },
      envLinks: {},
    },
    {
      id: 'client',
      name: 'Web Client',
      description:
        'Lightweight static file server for the game client. Uses the same image as the server — no separate build needed.',
      required: false,
      fallbacks: {
        proxyHttpUrl: '',
        proxyWsUrl: '',
      },
      sdlServiceName: 'web',
      inline: {
        dockerImage: 'ghcr.io/alternatefutures/hyperscape:v12',
        resources: { cpu: 0.5, memory: '256Mi', storage: '1Gi' },
        ports: [{ port: 80, as: 80, global: true }],
        healthCheck: { path: '/', port: 80 },
        startCommand:
          'printf \'if(!globalThis.env)globalThis.env={};globalThis.env={PUBLIC_API_URL:"%s",PUBLIC_WS_URL:"%s",PUBLIC_CDN_URL:"%s",PUBLIC_PRIVY_APP_ID:"%s"};\' "$PUBLIC_API_URL" "$PUBLIC_WS_URL" "$PUBLIC_CDN_URL" "$PUBLIC_PRIVY_APP_ID" > /app/packages/client/dist/env.js && cd /app/packages/client/dist && bun -e \'Bun.serve({port:80,async fetch(r){const u=new URL(r.url).pathname;const f=Bun.file("."+u);if(u!=="/"&&await f.exists())return new Response(f);return new Response(Bun.file("./index.html"),{headers:{"content-type":"text/html"}})}})\' ',
        pricingUakt: 1000,
      },
      envLinks: {
        PUBLIC_API_URL: '{{component.server.proxyHttpUrl}}',
        PUBLIC_WS_URL: '{{component.server.proxyWsUrl}}/ws',
        PUBLIC_CDN_URL: '{{component.assets.proxyHttpUrl}}',
        PUBLIC_PRIVY_APP_ID: '{{component.server.env.PUBLIC_PRIVY_APP_ID}}',
      },
    },
  ],
}
