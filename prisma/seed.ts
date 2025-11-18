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

  // Create Personal Access Token
  const pat = await prisma.personalAccessToken.upsert({
    where: { token: 'af_local_test_token_12345' },
    update: {},
    create: {
      id: 'pat-1',
      name: 'Local Test Token',
      token: 'af_local_test_token_12345',
      userId: user.id,
    },
  })
  console.log('✅ Created PAT:', pat.name)
  console.log('   Token:', pat.token)

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

  // Create a test site
  const site = await prisma.site.upsert({
    where: { slug: 'test-site' },
    update: {},
    create: {
      id: 'site-1',
      name: 'Test Site',
      slug: 'test-site',
      projectId: project.id,
    },
  })
  console.log('✅ Created site:', site.name)

  // Create test function with routes
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
    },
  })
  console.log('✅ Created function:', testFunction.name)
  console.log(
    '   Routes configured:',
    Object.keys(testFunction.routes as any).length
  )

  console.log('\n🎉 Seeding complete!')
  console.log('\n📋 Test credentials:')
  console.log('   Authorization: af_local_test_token_12345')
  console.log('   X-Project-Id: proj-1')
}

main()
  .catch(e => {
    console.error('Error seeding database:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
