import type { Template } from '../schema.js'

export const hyperscapeServer: Template = {
  id: 'hyperscape',
  name: 'Hyperscape',
  description:
    'AI-native MMORPG duel arena with real-time combat, physics (PhysX WASM), ElizaOS AI agents, and WebSocket architecture. Deploys game server (with embedded web client) and PostgreSQL.',
  featured: true,
  // Hidden from production builds — surfaces only in dev/staging via
  // `filterVisibleTemplates` so we can keep iterating on the composite
  // deploy flow without exposing it to end users yet.
  releaseStage: 'internal',
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
  dockerImage: 'ghcr.io/alternatefutures/hyperscape:v25',
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
      required: true,
    },
    {
      key: 'PRIVY_APP_SECRET',
      default: null,
      description:
        'Privy application secret for server-side token verification',
      required: true,
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
        'export UWS_ENABLED=false',
        'export LOG_LEVEL=info',
        'echo "[startup] UWS_ENABLED=$UWS_ENABLED LOG_LEVEL=$LOG_LEVEL"',
        'if [ -n "$POSTGRES_SERVICE_HOST" ]; then',
        '  export DATABASE_URL=$(echo "$DATABASE_URL" | sed "s/@postgres:/@${POSTGRES_SERVICE_HOST}:/")',
        '  echo "[startup] Resolved postgres -> $POSTGRES_SERVICE_HOST"',
        'fi',
        'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
        '  curl -so /dev/null --connect-timeout 2 http://${POSTGRES_SERVICE_HOST:-postgres}:5432/ 2>/dev/null',
        '  rc=$?; [ $rc -ne 6 ] && [ $rc -ne 7 ] && break',
        '  echo "[startup] Waiting for postgres ($i/15)..."',
        '  sleep 2',
        'done',
        'echo "[startup] Launching bun server..."',
        'exec bun --preload /app/packages/server/src/shared/polyfills.ts /app/packages/server/dist/index.js',
      ].join('\n'),
      envLinks: {
        DATABASE_URL:
          'postgresql://{{component.db.env.POSTGRES_USER}}:{{generated.password}}@{{component.db.host}}:5432/{{component.db.env.POSTGRES_DB}}',
        JWT_SECRET: '{{generated.secret}}',
        ARENA_EXTERNAL_BET_WRITE_KEY: '{{generated.secret}}',
        PORT: '5555',
        UWS_ENABLED: 'false',
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
      envDefaults: { PORT: '80' },
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
        dockerImage: 'ghcr.io/alternatefutures/hyperscape:v25',
        resources: { cpu: 0.5, memory: '256Mi', storage: '1Gi' },
        ports: [{ port: 80, as: 80, global: true }],
        healthCheck: { path: '/', port: 80 },
        startCommand: [
          'printf \'if(!globalThis.env)globalThis.env={};globalThis.env={PUBLIC_API_URL:"%s",PUBLIC_WS_URL:"%s",PUBLIC_CDN_URL:"%s",PUBLIC_PRIVY_APP_ID:"%s"};\' "$PUBLIC_API_URL" "$PUBLIC_WS_URL" "$PUBLIC_CDN_URL" "$PUBLIC_PRIVY_APP_ID" > /app/packages/client/dist/env.js',
          'cd /app/packages/client/dist',
          'exec node -e \'const h=require("http"),f=require("fs"),p=require("path"),d=process.cwd(),m={html:"text/html",js:"application/javascript",css:"text/css",json:"application/json",svg:"image/svg+xml",png:"image/png",ico:"image/x-icon",woff2:"font/woff2",wasm:"application/wasm",webp:"image/webp",jpg:"image/jpeg",mp3:"audio/mpeg",ogg:"audio/ogg",glb:"model/gltf-binary",bin:"application/octet-stream"};h.createServer((q,r)=>{let u=new URL(q.url,"http://l").pathname;if(u==="/")u="/index.html";let fp=p.join(d,u);if(!f.existsSync(fp))fp=p.join(d,"index.html");const ct=m[p.extname(fp).slice(1)]||"application/octet-stream";r.writeHead(200,{"Content-Type":ct,"Cache-Control":"public, max-age=31536000, immutable"});f.createReadStream(fp).pipe(r)}).listen(80,()=>console.log("Static server on :80"))\'',
        ].join(' && '),
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
