import type { Template } from '../schema.js'

export const telegramChatBot: Template = {
  id: 'telegram-chat-bot',
  name: 'Telegram Chat Bot (Standalone)',
  description:
    'Standalone polling Telegram bot. Runs without Next.js or webhooks and only needs a Telegram bot token.',
  featured: false,
  category: 'DEVTOOLS',
  tags: ['telegram', 'bot', 'chat-sdk', 'polling', 'nodejs'],
  icon: '✈️',
  repoUrl: '',
  dockerImage: 'ghcr.io/alternatefutures/telegram-chat-bot:v1',
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
