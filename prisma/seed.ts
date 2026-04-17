import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Create test user
  const user = await prisma.user.upsert({
    where: { email: 'test@alternatefutures.ai' },
    update: {},
    create: {
      id: 'test-user-1',
      email: 'test@alternatefutures.ai',
      username: 'testuser',
    },
  })
  console.log('✅ Created user:', user.email)

  // Create test project
  const project = await prisma.project.upsert({
    where: { slug: 'test-project' },
    update: {},
    create: {
      id: 'proj-1',
      name: 'Test Project',
      slug: 'test-project',
      userId: user.id,
    },
  })
  console.log('✅ Created project:', project.name)

  // Create Service for site (canonical registry entry)
  const siteService = await prisma.service.upsert({
    where: { type_slug: { type: 'SITE', slug: 'test-site' } },
    update: {},
    create: {
      id: 'svc-site-1',
      type: 'SITE',
      name: 'Test Site',
      slug: 'test-site',
      projectId: project.id,
      createdByUserId: user.id,
    },
  })
  console.log('✅ Created site service:', siteService.name)

  // Create a test site linked to service
  const site = await prisma.site.upsert({
    where: { slug: 'test-site' },
    update: {},
    create: {
      id: 'site-1',
      name: 'Test Site',
      slug: 'test-site',
      projectId: project.id,
      serviceId: siteService.id,
    },
  })
  console.log('✅ Created site:', site.name)

  // Create Service for function (canonical registry entry)
  const functionService = await prisma.service.upsert({
    where: { type_slug: { type: 'FUNCTION', slug: 'test-gateway' } },
    update: {},
    create: {
      id: 'svc-func-1',
      type: 'FUNCTION',
      name: 'test-gateway',
      slug: 'test-gateway',
      projectId: project.id,
      createdByUserId: user.id,
    },
  })
  console.log('✅ Created function service:', functionService.name)

  // Create test function linked to service
  const testFunction = await prisma.aFFunction.upsert({
    where: { slug: 'test-gateway' },
    update: {},
    create: {
      id: 'func-1',
      name: 'test-gateway',
      slug: 'test-gateway',
      invokeUrl: 'http://test-gateway.localhost:3000',
      routes: {
        '/api/users/*': 'https://jsonplaceholder.typicode.com/users',
        '/api/posts/*': 'https://jsonplaceholder.typicode.com/posts',
        '/*': 'https://httpbin.org/anything',
      },
      status: 'ACTIVE',
      projectId: project.id,
      serviceId: functionService.id,
    },
  })
  console.log('✅ Created function:', testFunction.name)
  console.log(
    '   Routes configured:',
    Object.keys(testFunction.routes as any).length
  )



  // ─── Seed Templates ─────────────────────────────────────────────────────────
  console.log('\n🌱 Seeding templates...')

  const templateData = [
    // AI / ML
    {
      id: 'tmpl-ollama-gpu',
      name: 'Ollama GPU',
      description: 'Run any open LLM (Llama 70B, Qwen 72B, Mistral, etc.) on GPU. OpenAI-compatible API included. Pull models on demand.',
      featured: true,
      category: 'AI_ML',
      tags: ['ai', 'llm', 'inference', 'gpu', 'ollama', 'openai'],
      icon: '🦙',
      repoUrl: 'https://github.com/ollama/ollama',
      dockerImage: 'ollama/ollama:0.6.2',
      serviceType: 'VM',
      envVars: [
        { key: 'OLLAMA_HOST', default: '0.0.0.0', description: 'Listen address', required: true },
        { key: 'OLLAMA_MODELS', default: '/data/models', description: 'Directory for model weights', required: true },
      ],
      resources: { cpu: 4, memory: '16Gi', storage: '10Gi', gpu: { units: 1, vendor: 'nvidia' } },
      ports: [{ port: 11434, as: 80, global: true }],
      persistentStorage: [{ name: 'ollama-models', size: '50Gi', mountPath: '/data/models' }],
      pricingUakt: BigInt(100000),
    },
    {
      id: 'tmpl-jupyter-ml',
      name: 'Jupyter ML Workspace',
      description: 'JupyterLab with PyTorch, TensorFlow, and Hugging Face pre-installed on GPU. Persistent storage for notebooks and datasets.',
      featured: false,
      category: 'AI_ML',
      tags: ['ai', 'jupyter', 'python', 'pytorch', 'gpu', 'data-science'],
      icon: '📓',
      repoUrl: 'https://github.com/jupyter/docker-stacks',
      dockerImage: 'quay.io/jupyter/pytorch-notebook:cuda12-latest',
      serviceType: 'VM',
      envVars: [
        { key: 'JUPYTER_TOKEN', default: null, description: 'Access token for JupyterLab', required: true, secret: true },
      ],
      resources: { cpu: 4, memory: '16Gi', storage: '10Gi', gpu: { units: 1, vendor: 'nvidia' } },
      ports: [{ port: 8888, as: 80, global: true }],
      persistentStorage: [{ name: 'jupyter-work', size: '50Gi', mountPath: '/home/jovyan/work' }],
      pricingUakt: BigInt(80000),
    },
    {
      id: 'tmpl-comfyui',
      name: 'ComfyUI',
      description: 'Node-based Stable Diffusion UI with GPU acceleration. Build complex image generation pipelines with a visual workflow editor.',
      featured: false,
      category: 'AI_ML',
      tags: ['ai', 'stable-diffusion', 'image-generation', 'gpu', 'comfyui'],
      icon: '🎨',
      repoUrl: 'https://github.com/comfyanonymous/ComfyUI',
      dockerImage: 'yanwk/comfyui-boot:cu124-slim',
      serviceType: 'VM',
      envVars: [
        { key: 'CLI_ARGS', default: '--listen 0.0.0.0 --port 8188', description: 'ComfyUI command-line arguments', required: true },
      ],
      resources: { cpu: 4, memory: '16Gi', storage: '20Gi', gpu: { units: 1, vendor: 'nvidia' } },
      ports: [{ port: 8188, as: 80, global: true }],
      persistentStorage: [
        { name: 'comfyui-models', size: '50Gi', mountPath: '/root/ComfyUI/models' },
        { name: 'comfyui-output', size: '10Gi', mountPath: '/root/ComfyUI/output' },
      ],
      pricingUakt: BigInt(80000),
    },
    // Web Servers
    {
      id: 'tmpl-nextjs',
      name: 'Next.js App',
      description: 'Next.js 14 production server with App Router and SSR. Deploy your Next.js application with standalone output mode.',
      featured: true,
      category: 'WEB_SERVER',
      tags: ['web', 'nextjs', 'react', 'ssr', 'nodejs', 'frontend'],
      icon: '▲',
      repoUrl: 'https://github.com/vercel/next.js',
      dockerImage: 'node:22-alpine',
      serviceType: 'VM',
      envVars: [
        { key: 'PORT', default: '3000', description: 'HTTP listen port', required: true },
        { key: 'NODE_ENV', default: 'production', description: 'Node.js environment', required: true },
      ],
      resources: { cpu: 0.5, memory: '512Mi', storage: '2Gi' },
      ports: [{ port: 3000, as: 80, global: true }],
      healthCheck: { path: '/', port: 3000 },
      pricingUakt: BigInt(800),
    },
    {
      id: 'tmpl-react-vite',
      name: 'React + Vite',
      description: 'React SPA served by Nginx. Built with Vite for fast builds. Perfect for client-side rendered applications.',
      featured: false,
      category: 'WEB_SERVER',
      tags: ['web', 'react', 'vite', 'spa', 'nginx', 'frontend'],
      icon: '⚡',
      repoUrl: 'https://github.com/vitejs/vite',
      dockerImage: 'nginx:1.27-alpine',
      serviceType: 'VM',
      envVars: [],
      resources: { cpu: 0.25, memory: '256Mi', storage: '1Gi' },
      ports: [{ port: 80, as: 80, global: true }],
      healthCheck: { path: '/', port: 80 },
      pricingUakt: BigInt(400),
    },
    {
      id: 'tmpl-astro',
      name: 'Astro',
      description: "Astro 4 with Node.js SSR adapter. Ship less JavaScript with Astro's island architecture.",
      featured: false,
      category: 'WEB_SERVER',
      tags: ['web', 'astro', 'ssr', 'static', 'nodejs', 'frontend'],
      icon: '🚀',
      repoUrl: 'https://github.com/withastro/astro',
      dockerImage: 'node:22-alpine',
      serviceType: 'VM',
      envVars: [
        { key: 'PORT', default: '4321', description: 'Astro server listen port', required: true },
        { key: 'HOST', default: '0.0.0.0', description: 'Astro server listen host', required: true },
      ],
      resources: { cpu: 0.25, memory: '256Mi', storage: '1Gi' },
      ports: [{ port: 4321, as: 80, global: true }],
      healthCheck: { path: '/', port: 4321 },
      pricingUakt: BigInt(400),
    },
    {
      id: 'tmpl-nuxt',
      name: 'Vue / Nuxt',
      description: 'Nuxt 3 with server-side rendering and Vue 3 Composition API. Full-stack Vue framework with SEO-friendly SSR.',
      featured: false,
      category: 'WEB_SERVER',
      tags: ['web', 'vue', 'nuxt', 'ssr', 'nodejs', 'frontend'],
      icon: '💚',
      repoUrl: 'https://github.com/nuxt/nuxt',
      dockerImage: 'node:22-alpine',
      serviceType: 'VM',
      envVars: [
        { key: 'PORT', default: '3000', description: 'Nuxt server listen port', required: true },
        { key: 'HOST', default: '0.0.0.0', description: 'Nuxt server listen host', required: true },
      ],
      resources: { cpu: 0.5, memory: '512Mi', storage: '1Gi' },
      ports: [{ port: 3000, as: 80, global: true }],
      healthCheck: { path: '/', port: 3000 },
      pricingUakt: BigInt(800),
    },
    {
      id: 'tmpl-hugo',
      name: 'Hugo',
      description: 'Hugo static site generator served by Nginx. One of the fastest static site generators with Markdown-driven content.',
      featured: false,
      category: 'WEB_SERVER',
      tags: ['web', 'hugo', 'static', 'blog', 'nginx', 'go'],
      icon: '📄',
      repoUrl: 'https://github.com/gohugoio/hugo',
      dockerImage: 'nginx:1.27-alpine',
      serviceType: 'VM',
      envVars: [],
      resources: { cpu: 0.25, memory: '128Mi', storage: '512Mi' },
      ports: [{ port: 80, as: 80, global: true }],
      healthCheck: { path: '/', port: 80 },
      pricingUakt: BigInt(300),
    },
    // Databases
    {
      id: 'tmpl-postgres',
      name: 'PostgreSQL',
      description: 'PostgreSQL 16 Alpine — lightweight, production-ready relational database with persistent storage.',
      featured: true,
      category: 'DATABASE',
      tags: ['database', 'sql', 'postgres', 'relational'],
      icon: '🐘',
      repoUrl: 'https://hub.docker.com/_/postgres',
      dockerImage: 'postgres:16-alpine',
      serviceType: 'DATABASE',
      envVars: [
        { key: 'POSTGRES_DB', default: 'appdb', description: 'Default database name', required: true },
        { key: 'POSTGRES_USER', default: 'postgres', description: 'Database superuser name', required: true },
        { key: 'POSTGRES_PASSWORD', default: null, description: 'Database superuser password', required: true, secret: true },
      ],
      resources: { cpu: 0.5, memory: '1Gi', storage: '1Gi' },
      ports: [{ port: 5432, as: 5432, global: true }],
      persistentStorage: [{ name: 'pgdata', size: '10Gi', mountPath: '/var/lib/postgresql/data' }],
      pricingUakt: BigInt(1500),
    },
    {
      id: 'tmpl-redis',
      name: 'Redis',
      description: 'Redis 7 Alpine — in-memory key-value store. Use for caching, pub/sub, queues, and session storage.',
      featured: true,
      category: 'DATABASE',
      tags: ['database', 'cache', 'redis', 'key-value', 'pubsub'],
      icon: '🔴',
      repoUrl: 'https://hub.docker.com/_/redis',
      dockerImage: 'redis:7-alpine',
      serviceType: 'DATABASE',
      envVars: [
        { key: 'REDIS_PASSWORD', default: null, description: 'Redis AUTH password', required: false, secret: true },
      ],
      resources: { cpu: 0.25, memory: '512Mi', storage: '512Mi' },
      ports: [{ port: 6379, as: 6379, global: true }],
      persistentStorage: [{ name: 'redis-data', size: '5Gi', mountPath: '/data' }],
      pricingUakt: BigInt(700),
    },
    // Game Servers
    {
      id: 'tmpl-minecraft',
      name: 'Minecraft Server',
      description: "Minecraft Java Edition server. Supports Vanilla, Paper, Fabric, Forge, and more. Auto-downloads server JAR on first start.",
      featured: true,
      category: 'GAME_SERVER',
      tags: ['minecraft', 'gameserver', 'java', 'multiplayer'],
      icon: '⛏️',
      repoUrl: 'https://github.com/itzg/docker-minecraft-server',
      dockerImage: 'itzg/minecraft-server:java21',
      serviceType: 'VM',
      envVars: [
        { key: 'EULA', default: 'TRUE', description: 'Accept Minecraft EULA', required: true },
        { key: 'TYPE', default: 'PAPER', description: 'Server type: VANILLA, PAPER, FABRIC, FORGE', required: true },
        { key: 'VERSION', default: 'LATEST', description: 'Minecraft version', required: true },
        { key: 'MEMORY', default: '2G', description: 'JVM heap size (e.g. 2G, 4G)', required: true },
        { key: 'MAX_PLAYERS', default: '20', description: 'Maximum number of players', required: false },
      ],
      resources: { cpu: 2, memory: '4Gi', storage: '10Gi' },
      ports: [{ port: 25565, as: 25565, global: true }],
      persistentStorage: [{ name: 'minecraft-data', size: '20Gi', mountPath: '/data' }],
      pricingUakt: BigInt(5000),
    },
    // DevTools
    {
      id: 'tmpl-gitea',
      name: 'Gitea',
      description: 'Self-hosted Git service — GitHub/GitLab alternative written in Go. Lightweight with issues, PRs, CI/CD, and packages.',
      featured: true,
      category: 'DEVTOOLS',
      tags: ['git', 'devtools', 'vcs', 'self-hosted', 'go'],
      icon: '🍵',
      repoUrl: 'https://github.com/go-gitea/gitea',
      dockerImage: 'gitea/gitea:1.21-rootless',
      serviceType: 'VM',
      envVars: [
        { key: 'GITEA__server__ROOT_URL', default: 'http://localhost:3000', description: 'Public URL of the Gitea instance', required: true },
        { key: 'GITEA__security__SECRET_KEY', default: null, description: 'Secret key for token signing', required: true, secret: true },
      ],
      resources: { cpu: 0.5, memory: '512Mi', storage: '2Gi' },
      ports: [
        { port: 3000, as: 80, global: true },
        { port: 2222, as: 2222, global: true },
      ],
      persistentStorage: [{ name: 'gitea-data', size: '20Gi', mountPath: '/var/lib/gitea' }],
      pricingUakt: BigInt(1000),
    },
    {
      id: 'tmpl-n8n',
      name: 'n8n',
      description: 'Workflow automation platform — the open-source alternative to Zapier. Connect 400+ apps with a visual editor and AI-powered automations.',
      featured: true,
      category: 'DEVTOOLS',
      tags: ['automation', 'workflow', 'devtools', 'n8n', 'no-code', 'integration'],
      icon: '🔗',
      repoUrl: 'https://github.com/n8n-io/n8n',
      dockerImage: 'n8nio/n8n:1.93.0',
      serviceType: 'VM',
      envVars: [
        { key: 'N8N_PORT', default: '5678', description: 'n8n server listen port', required: true },
        { key: 'N8N_ENCRYPTION_KEY', default: null, description: 'Encryption key for stored credentials', required: true, secret: true },
        { key: 'WEBHOOK_URL', default: null, description: 'Public URL for incoming webhooks', required: true },
      ],
      resources: { cpu: 0.5, memory: '1Gi', storage: '2Gi' },
      ports: [{ port: 5678, as: 80, global: true }],
      healthCheck: { path: '/healthz', port: 5678 },
      persistentStorage: [{ name: 'n8n-data', size: '10Gi', mountPath: '/home/node/.n8n' }],
      pricingUakt: BigInt(2000),
    },
  ]

  for (const t of templateData) {
    const { healthCheck, persistentStorage, ...rest } = t
    await prisma.template.upsert({
      where: { id: t.id },
      update: {},
      create: {
        ...rest,
        healthCheck: healthCheck ?? null,
        persistentStorage: persistentStorage ?? null,
      },
    })
    console.log(`  ✅ Template: ${t.name}`)
  }

  console.log(`\n📦 Seeded ${templateData.length} templates`)

  // ─── Seed Promo Codes ────────────────────────────────────────────────────────
  console.log('\n🎫 Seeding promo codes...')

  await prisma.promoCode.upsert({
    where: { code: 'PRODUCTHUNT' },
    update: {},
    create: {
      code: 'PRODUCTHUNT',
      description: '6 months free Pro tier — Product Hunt launch promo',
      discountType: 'FREE_MONTHS',
      discountValue: 6,
      appliesToPlan: 'PRO',
      maxRedemptions: 500,
      expiresAt: new Date('2026-06-30T23:59:59Z'),
      isActive: true,
    },
  })
  console.log('  ✅ Promo code: PRODUCTHUNT (6 months free Pro, max 500 redemptions)')

  console.log('\n🎉 Seeding complete!')
  console.log('\n📋 Test data:')
  console.log('   User: test@alternatefutures.ai')
  console.log('   Project ID: proj-1')
  console.log('   Project Slug: test-project')
}

main()
  .catch(e => {
    console.error('Error seeding database:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
