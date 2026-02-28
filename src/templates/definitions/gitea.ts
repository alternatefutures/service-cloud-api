import type { Template } from '../schema.js'

export const giteaServer: Template = {
  id: 'gitea',
  name: 'Gitea',
  description:
    'Self-hosted Git service — GitHub/GitLab alternative written in Go. Lightweight, fast, and packed with features: issues, pull requests, CI/CD, packages.',
  featured: true,
  category: 'DEVTOOLS',
  tags: ['git', 'devtools', 'vcs', 'self-hosted', 'go', 'gitea'],
  icon: '🍵',
  repoUrl: 'https://github.com/go-gitea/gitea',
  dockerImage: 'gitea/gitea:1.21-rootless',
  serviceType: 'VM',
  envVars: [
    {
      key: 'GITEA__server__ROOT_URL',
      default: 'http://localhost:3000',
      description: 'Public URL of the Gitea instance (update to your deployed URL)',
      required: true,
    },
    {
      key: 'GITEA__server__HTTP_PORT',
      default: '3000',
      description: 'HTTP listen port',
      required: true,
    },
    {
      key: 'GITEA__database__DB_TYPE',
      default: 'sqlite3',
      description: 'Database type (sqlite3, postgres, mysql)',
      required: true,
    },
    {
      key: 'GITEA__security__SECRET_KEY',
      default: null,
      description: 'Secret key for token signing (generate a random 64-char string)',
      required: true,
      secret: true,
    },
  ],
  resources: {
    cpu: 0.5,
    memory: '512Mi',
    storage: '2Gi',
  },
  ports: [
    { port: 3000, as: 80, global: true },
    { port: 2222, as: 2222, global: true },
  ],
  persistentStorage: [
    {
      name: 'gitea-data',
      size: '20Gi',
      mountPath: '/var/lib/gitea',
    },
  ],
  pricingUakt: 1000,
}
