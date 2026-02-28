import type { Template } from '../schema.js'

export const minecraftServer: Template = {
  id: 'minecraft-server',
  name: 'Minecraft Server',
  description:
    'Minecraft Java Edition server with itzg\'s production-hardened image. Supports Vanilla, Paper, Fabric, Forge, and more. Auto-downloads server JAR on first start.',
  featured: true,
  category: 'GAME_SERVER',
  tags: ['minecraft', 'gameserver', 'java', 'multiplayer', 'game'],
  icon: '⛏️',
  repoUrl: 'https://github.com/itzg/docker-minecraft-server',
  dockerImage: 'itzg/minecraft-server:java21',
  serviceType: 'VM',
  envVars: [
    {
      key: 'EULA',
      default: 'TRUE',
      description: 'Accept Minecraft EULA (must be TRUE)',
      required: true,
    },
    {
      key: 'TYPE',
      default: 'PAPER',
      description: 'Server type: VANILLA, PAPER, FABRIC, FORGE, BUKKIT, SPIGOT',
      required: true,
    },
    {
      key: 'VERSION',
      default: 'LATEST',
      description: 'Minecraft version (e.g. 1.21.4 or LATEST)',
      required: true,
    },
    {
      key: 'MEMORY',
      default: '2G',
      description: 'JVM heap size (e.g. 2G, 4G)',
      required: true,
    },
    {
      key: 'DIFFICULTY',
      default: 'normal',
      description: 'Game difficulty: peaceful, easy, normal, hard',
      required: false,
    },
    {
      key: 'MAX_PLAYERS',
      default: '20',
      description: 'Maximum number of players',
      required: false,
    },
    {
      key: 'MOTD',
      default: 'A Minecraft Server on Alternate Futures',
      description: 'Message of the day shown in the server list',
      required: false,
    },
    {
      key: 'RCON_PASSWORD',
      default: null,
      description: 'RCON remote console password',
      required: false,
      secret: true,
    },
  ],
  resources: {
    cpu: 2,
    memory: '4Gi',
    storage: '10Gi',
  },
  ports: [
    { port: 25565, as: 25565, global: true },
    { port: 25575, as: 25575, global: false },
  ],
  persistentStorage: [
    {
      name: 'minecraft-data',
      size: '20Gi',
      mountPath: '/data',
    },
  ],
  pricingUakt: 5000,
}
