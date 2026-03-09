import type { Template } from '../schema.js'

export const hyperscapeServer: Template = {
  id: 'hyperscape',
  name: 'Hyperscape',
  description:
    'AI-native MMORPG duel arena server with real-time combat, physics (PhysX WASM), ElizaOS AI agents, and WebSocket architecture. Includes bundled PostgreSQL — deploys fully self-contained.',
  featured: true,
  category: 'GAME_SERVER',
  tags: ['game', 'mmorpg', 'rpg', 'multiplayer', 'websocket', 'ai', 'agents', 'metaverse', 'tee', 'duel-arena'],
  icon: '/templates/hyperscape.png',
  repoUrl: 'https://github.com/HyperscapeAI/hyperscape',
  dockerImage: 'ghcr.io/alternatefutures/hyperscape:v2',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PUBLIC_CDN_URL',
      default: 'https://assets.hyperscape.club',
      description: 'CDN base URL for game assets (models, textures, audio)',
      required: true,
    },
    {
      key: 'OPENAI_API_KEY',
      default: null,
      description: 'OpenAI API key for AI agents (optional — enables LLM-powered NPCs)',
      required: false,
      secret: true,
    },
    {
      key: 'ANTHROPIC_API_KEY',
      default: null,
      description: 'Anthropic API key for AI agents (optional alternative provider)',
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
  ports: [
    { port: 5555, as: 80, global: true },
  ],
  healthCheck: {
    path: '/status',
    port: 5555,
  },
  persistentStorage: [
    {
      name: 'hyperscape-data',
      size: '10Gi',
      mountPath: '/app/data',
    },
  ],
  pricingUakt: 4000,

  companions: [
    {
      templateId: 'postgres',
      namePrefix: 'hyperscape-db',
      envDefaults: {
        POSTGRES_DB: 'hyperscape',
        POSTGRES_USER: 'hyperscape',
      },
      autoLink: true,
    },
  ],

  customSdl: `---
version: "2.0"

services:
  postgres:
    image: postgres:16-alpine
    env:
      - POSTGRES_DB=hyperscape
      - POSTGRES_USER=hyperscape
      - POSTGRES_PASSWORD={{GENERATED_PASSWORD}}
      - PGDATA=/var/lib/postgresql/data/pgdata
    expose:
      - port: 5432
        to:
          - service: {{SERVICE_NAME}}
    params:
      storage:
        hyperscape-db:
          mount: /var/lib/postgresql/data
          readOnly: false

  {{SERVICE_NAME}}:
    image: ghcr.io/alternatefutures/hyperscape:v2
    env:
      - DATABASE_URL=postgresql://hyperscape:{{GENERATED_PASSWORD}}@postgres:5432/hyperscape
      - JWT_SECRET={{GENERATED_SECRET}}
      - ARENA_EXTERNAL_BET_WRITE_KEY={{GENERATED_SECRET}}
      - PORT=5555
      - NODE_ENV=production
      - USE_LOCAL_POSTGRES=false
      - PLAYWRIGHT_TEST=true
      - PUBLIC_CDN_URL={{ENV.PUBLIC_CDN_URL}}
      - SAVE_INTERVAL={{ENV.SAVE_INTERVAL}}
    expose:
      - port: 5555
        as: 80
        to:
          - global: true
    params:
      storage:
        hyperscape-data:
          mount: /app/data
          readOnly: false

profiles:
  compute:
    postgres:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          - size: 1Gi
          - name: hyperscape-db
            size: 10Gi
            attributes:
              persistent: true
              class: beta3

    {{SERVICE_NAME}}:
      resources:
        cpu:
          units: 2
        memory:
          size: 4Gi
        storage:
          - size: 4Gi
          - name: hyperscape-data
            size: 10Gi
            attributes:
              persistent: true
              class: beta3

  placement:
    dcloud:
      pricing:
        postgres:
          denom: uakt
          amount: 1000
        {{SERVICE_NAME}}:
          denom: uakt
          amount: 3000

deployment:
  postgres:
    dcloud:
      profile: postgres
      count: 1
  {{SERVICE_NAME}}:
    dcloud:
      profile: {{SERVICE_NAME}}
      count: 1
`,
}
