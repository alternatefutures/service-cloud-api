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
