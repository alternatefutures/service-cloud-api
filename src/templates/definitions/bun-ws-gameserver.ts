import type { Template } from '../schema.js'

export const bunWsGameserver: Template = {
  id: 'bun-ws-gameserver',
  name: 'Bun Game Server',
  description:
    'Bun-native WebSocket relay server — same protocol as the Node.js version but 5-8x faster. Protocol-agnostic relay with Bun built-in pub/sub for room broadcasting.',
  category: 'GAME_SERVER',
  tags: ['websocket', 'multiplayer', 'realtime', 'gameserver', 'msgpack', 'bun'],
  icon: '⚡',
  repoUrl: 'https://github.com/mavisakalyan/bun-ws-gameserver',
  dockerImage: 'ghcr.io/mavisakalyan/bun-ws-gameserver:latest',
  serviceType: 'VM',
  envVars: [
    {
      key: 'PORT',
      default: '8080',
      description: 'Server listen port',
      required: true,
    },
    {
      key: 'ALLOWED_ORIGINS',
      default: '*',
      description: 'Comma-separated allowed origins for WebSocket connections',
      required: false,
    },
    {
      key: 'KEEPALIVE_MS',
      default: '30000',
      description: 'WebSocket keepalive ping interval in milliseconds',
      required: false,
    },
    {
      key: 'MAX_MESSAGES_PER_SECOND',
      default: '60',
      description: 'Per-client rate limit (sliding window)',
      required: false,
    },
    {
      key: 'MAX_PLAYERS_PER_ROOM',
      default: '50',
      description: 'Maximum players per room',
      required: false,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '512Mi',
    storage: '1Gi',
  },
  ports: [
    { port: 8080, as: 80, global: true },
  ],
  healthCheck: {
    path: '/health',
    port: 8080,
  },
  pricingUakt: 1000,
  startCommand: 'bun src/index.ts',
}
