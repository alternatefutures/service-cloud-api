import type { Template } from '../schema.js'

export const nodeWsGameserver: Template = {
  id: 'node-ws-gameserver',
  name: 'Node.js Game Server',
  description:
    'Protocol-agnostic WebSocket relay server with room-based architecture and binary protocol (msgpack). Relays any game data between peers without inspecting payloads.',
  featured: true,
  category: 'GAME_SERVER',
  tags: ['websocket', 'multiplayer', 'realtime', 'gameserver', 'msgpack', 'node'],
  icon: '🎮',
  repoUrl: 'https://github.com/mavisakalyan/node-ws-gameserver',
  dockerImage: 'ghcr.io/mavisakalyan/node-ws-gameserver:latest',
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
  startCommand: 'node dist/index.js',
}
