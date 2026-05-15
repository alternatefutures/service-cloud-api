/**
 * Smoke test — verify generateCustomDockerSDL emits the right
 * persistent-storage YAML when volumes are attached.
 *
 * Run from service-cloud-api/:
 *   pnpm tsx scripts/test-volumes-sdl.ts
 *
 * This does not touch the DB or Akash. It instantiates the orchestrator,
 * pokes its private SDL builder, and prints the resulting SDL alongside the
 * expected blocks so we can eyeball it.
 */

import { PrismaClient } from '@prisma/client'
import { getAkashOrchestrator, parseServiceVolumes } from '../src/services/akash/orchestrator.js'

const prisma = new PrismaClient()

function divider(title: string) {
  console.log('\n' + '─'.repeat(70))
  console.log('  ' + title)
  console.log('─'.repeat(70))
}

async function main() {
  const orchestrator: any = getAkashOrchestrator(prisma)

  // ── Test 1: parseServiceVolumes accepts/rejects the right shapes ──────
  divider('parseServiceVolumes — input filtering')

  const validInput = [
    { name: 'data', mountPath: '/data', size: '5Gi' },
    { name: 'pgdata', mountPath: '/var/lib/postgresql/data', size: '10Gi' },
  ]
  console.log('valid input →', JSON.stringify(parseServiceVolumes(validInput)))

  const mixedInput = [
    { name: 'data', mountPath: '/data', size: '5Gi' },
    { name: 'BAD-NAME', mountPath: '/x', size: '1Gi' },          // rejected: uppercase
    { name: 'ok', mountPath: 'no-slash', size: '1Gi' },          // rejected: relative path
    { name: 'ok2', mountPath: '/data2', size: '5xx' },           // rejected: bad size
    { name: 'good2', mountPath: '/cache', size: '500Mi' },
  ]
  console.log('mixed input → kept:', JSON.stringify(parseServiceVolumes(mixedInput)))
  // Expected: only the two well-formed entries survive.

  console.log('null/undefined →', JSON.stringify(parseServiceVolumes(null)), JSON.stringify(parseServiceVolumes(undefined)))
  // Expected: [] for both.

  // ── Test 2: SDL with NO volumes (regression — old behaviour) ─────────
  divider('SDL — no volumes (regression check)')

  const sdlNoVolumes = orchestrator.generateCustomDockerSDL(
    'test-svc',
    'nginx:1.25-alpine',
    80,
    undefined,
    [],
  )
  console.log(sdlNoVolumes)
  console.log('☐ Should NOT contain "params:" block')
  console.log('☐ Should NOT contain "persistent: true"')
  console.log('☐ Should contain `- size: 1Gi` (default ephemeral)')

  // ── Test 3: SDL with one volume (Milady-shaped) ───────────────────────
  divider('SDL — single volume (Milady-shaped)')

  const sdlMilady = orchestrator.generateCustomDockerSDL(
    'milady',
    'ghcr.io/alternatefutures/milady:v9',
    2138,
    { cpu: 2, memory: '4Gi', storage: '5Gi' },
    [{ name: 'milady-state', mountPath: '/home/node/.milady', size: '10Gi' }],
  )
  console.log(sdlMilady)
  console.log('☑ Should contain `params:` → `storage:` → `milady-state:` → `mount: /home/node/.milady`')
  console.log('☑ Should contain `- name: milady-state`, `size: 10Gi`, `persistent: true`, `class: beta3`')
  console.log('☑ Should contain `- size: 5Gi` (ephemeral) BEFORE the named volume')

  // ── Test 4: SDL with two volumes (Postgres-shaped) ────────────────────
  divider('SDL — two volumes (postgres + cache)')

  const sdlPg = orchestrator.generateCustomDockerSDL(
    'pg',
    'postgres:16-alpine',
    5432,
    undefined,
    [
      { name: 'pgdata', mountPath: '/var/lib/postgresql/data', size: '20Gi' },
      { name: 'pgcache', mountPath: '/cache', size: '5Gi' },
    ],
  )
  console.log(sdlPg)
  console.log('☑ Two `params.storage.*` mount entries in declared order')
  console.log('☑ Two named storage entries each with persistent/class')
}

main()
  .catch((err) => {
    console.error('Test failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
