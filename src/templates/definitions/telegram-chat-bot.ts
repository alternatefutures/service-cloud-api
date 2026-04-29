import type { Template } from '../schema.js'

export const telegramChatBot: Template = {
  id: 'telegram-chat-bot',
  name: 'Telegram Community Bot Runner',
  description:
    'One-click Telegram bot runner for project communities. Add a bot token, project context, links, and guardrails; it runs 24/7 without webhooks.',
  featured: false,
  category: 'DEVTOOLS',
  tags: ['telegram', 'community', 'bot', 'faq', 'support'],
  icon: '✈️',
  repoUrl: '',
  dockerImage: 'ghcr.io/alternatefutures/telegram-community-bot:v2',
  serviceType: 'VM',
  envVars: [
    {
      key: 'TELEGRAM_BOT_TOKEN',
      default: null,
      description: 'Telegram bot token from @BotFather',
      required: true,
      secret: true,
    },
    {
      key: 'TELEGRAM_BOT_USERNAME',
      default: 'telegramchatdemobot',
      description: 'Telegram bot username (without @)',
      required: false,
    },
    {
      key: 'PROJECT_NAME',
      default: 'My Project',
      description: 'Project or community name the bot represents',
      required: true,
    },
    {
      key: 'PROJECT_CONTEXT',
      default: 'Describe what your project does and who it is for.',
      description: 'Source-of-truth project explanation used in bot replies',
      required: true,
    },
    {
      key: 'PROJECT_STATUS',
      default: 'Early community stage.',
      description: 'Current status, launch stage, or availability note',
      required: false,
    },
    {
      key: 'PRIMARY_LINK',
      default: '',
      description: 'Main link to share with the community',
      required: false,
    },
    {
      key: 'SECONDARY_LINK',
      default: '',
      description: 'Optional secondary link such as docs, app, repo, or leaderboard',
      required: false,
    },
    {
      key: 'COMMUNITY_GOAL',
      default: '',
      description: 'What the community should do next or understand',
      required: false,
    },
    {
      key: 'BOT_PERSONA',
      default: 'Be concise, friendly, and factual.',
      description: 'Tone and style for bot responses',
      required: false,
    },
    {
      key: 'GUARDRAILS',
      default:
        'Do not claim a token has launched unless the project context explicitly says so. Do not give financial advice.',
      description: 'Claims the bot must avoid or constraints it must follow',
      required: false,
    },
    {
      key: 'PORT',
      default: '3000',
      description: 'Health endpoint port used by platform checks',
      required: true,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '768Mi',
    storage: '4Gi',
  },
  ports: [{ port: 3000, as: 80, global: true }],
  healthCheck: {
    path: '/',
    port: 3000,
  },
  pricingUakt: 1000,
}
