#!/usr/bin/env npx tsx
/**
 * Verify Phala implementation (Steps 4.1–4.3).
 * Run: npx tsx scripts/verify-phala-implementation.ts
 */
import 'dotenv/config'
import { execSync } from 'child_process'

const failures: string[] = []

function ok(name: string) {
  console.log(`   ✓ ${name}`)
}

function fail(name: string, msg: string) {
  console.log(`   ✗ ${name}: ${msg}`)
  failures.push(`${name}: ${msg}`)
}

async function testPrisma() {
  console.log('\n1. Prisma: PhalaDeployment model')
  try {
    const { PrismaClient } = await import('@prisma/client')
    const p = new PrismaClient()
    const count = await p.phalaDeployment.count()
    await p.$disconnect()
    ok(`PhalaDeployment table exists, count=${count}`)
  } catch (e: any) {
    fail('PhalaDeployment', e.message)
  }
}

async function testComposeGenerator() {
  console.log('\n2. Compose generator: generateComposeFromTemplate')
  try {
    const { generateComposeFromTemplate, getEnvKeysFromTemplate } = await import(
      '../src/templates/index.js'
    )
    const { postgres } = await import('../src/templates/definitions/postgres.js')
    const { nanobotGateway } = await import(
      '../src/templates/definitions/nanobot-gateway.js'
    )

    // Postgres
    const pgCompose = generateComposeFromTemplate(postgres, {
      envOverrides: { POSTGRES_PASSWORD: 'secret' },
    })
    if (!pgCompose.includes('services:')) fail('postgres compose', 'missing services:')
    else if (!pgCompose.includes('app:')) fail('postgres compose', 'missing app:')
    else if (!pgCompose.includes('postgres:16-alpine')) fail('postgres compose', 'wrong image')
    else if (!pgCompose.includes('tappd.sock')) fail('postgres compose', 'missing TEE socket')
    else if (!pgCompose.includes('pgdata:')) fail('postgres compose', 'missing pgdata volume')
    else if (!pgCompose.includes('5432:5432')) fail('postgres compose', 'wrong port mapping')
    else ok('postgres: valid compose structure')

    // Nanobot
    const nbCompose = generateComposeFromTemplate(nanobotGateway)
    if (!nbCompose.includes('nanobot-akash')) fail('nanobot compose', 'wrong image')
    else if (!nbCompose.includes('80:18790')) fail('nanobot compose', 'wrong port mapping')
    else if (!nbCompose.includes('nanobot-state')) fail('nanobot compose', 'missing volume')
    else ok('nanobot: valid compose structure')

    // Env keys (no values)
    const keys = getEnvKeysFromTemplate(postgres, { POSTGRES_PASSWORD: 'x' })
    if (!keys.includes('POSTGRES_PASSWORD')) fail('getEnvKeysFromTemplate', 'missing key')
    else if (keys.some(k => typeof k !== 'string')) fail('getEnvKeysFromTemplate', 'invalid keys')
    else ok('getEnvKeysFromTemplate: returns keys only (no values)')
  } catch (e: any) {
    fail('compose generator', e.message)
  }
}

async function testPhalaApi() {
  console.log('\n3. Phala API connection')
  const PHALA_API_KEY = process.env.PHALA_API_KEY
  if (!PHALA_API_KEY || PHALA_API_KEY.trim() === '') {
    fail('PHALA_API_KEY', 'not set in .env')
    return
  }

  try {
    const env = { ...process.env, PHALA_CLOUD_API_KEY: PHALA_API_KEY }
    const statusOut = execSync('npx phala status --json', {
      stdio: 'pipe',
      encoding: 'utf-8',
      env,
    })
    const status = JSON.parse(statusOut)
    if (!status?.success) fail('phala status', 'API returned success=false')
    else ok('phala status: authenticated')
  } catch (e: any) {
    fail('phala API', e.message)
  }
}

async function main() {
  console.log('=== Phala implementation verification (Steps 4.1–4.3) ===')

  await testPrisma()
  await testComposeGenerator()
  await testPhalaApi()

  console.log('\n---')
  if (failures.length > 0) {
    console.error('\n❌ Failures:', failures.length)
    failures.forEach(f => console.error('   -', f))
    process.exit(1)
  }
  console.log('\n✅ All checks passed')
}

main()
