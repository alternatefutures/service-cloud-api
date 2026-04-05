#!/usr/bin/env bun
/**
 * Sync compute_provider and provider_template_result from local DB
 * to staging and production databases via kubectl exec psql.
 *
 * Generates a single SQL batch and pipes it in one kubectl exec call.
 *
 * Usage:
 *   bun scripts/sync-providers-to-envs.ts [--staging-only | --prod-only]
 */

import { PrismaClient } from '@prisma/client'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const KUBECONFIG = `${process.env.HOME}/.kube/af-k3s-kubeconfig.yaml`

interface TargetEnv {
  name: string
  namespace: string
  database: string
}

const ENVS: TargetEnv[] = [
  { name: 'staging', namespace: 'af-production', database: 'alternatefutures_staging' },
  { name: 'production', namespace: 'af-production', database: 'alternatefutures' },
]

function esc(s: string | null | undefined): string {
  if (s == null) return 'NULL'
  return `'${s.replace(/'/g, "''")}'`
}

async function main() {
  const args = process.argv.slice(2)
  const stagingOnly = args.includes('--staging-only')
  const prodOnly = args.includes('--prod-only')

  const targets = ENVS.filter(e => {
    if (stagingOnly) return e.name === 'staging'
    if (prodOnly) return e.name === 'production'
    return true
  })

  console.log('Reading local database...')
  const prisma = new PrismaClient()

  try {
    // Only sync providers that have been tested or have GPU capacity — not the full 1600+ registry
    const providers = await prisma.computeProvider.findMany({
      where: {
        OR: [
          { lastTestedAt: { not: null } },
          { gpuTotal: { gt: 0 } },
          { verified: true },
        ],
      },
      orderBy: { address: 'asc' },
    })

    const templateResults = await prisma.providerTemplateResult.findMany({
      include: { provider: { select: { address: true } } },
    })

    console.log(`  Found ${providers.length} relevant providers (tested/GPU/verified), ${templateResults.length} template results\n`)

    for (const env of targets) {
      console.log(`${'═'.repeat(60)}`)
      console.log(`  Syncing to ${env.name.toUpperCase()} (${env.database})`)
      console.log('═'.repeat(60))

      const sqlLines: string[] = ['BEGIN;']

      for (const p of providers) {
        const gpuModelsArr = p.gpuModels.length > 0
          ? `ARRAY[${p.gpuModels.map(m => esc(m)).join(',')}]::text[]`
          : `ARRAY[]::text[]`

        const minPrice = p.minPriceUact !== null ? p.minPriceUact.toString() : 'NULL'
        const maxPrice = p.maxPriceUact !== null ? p.maxPriceUact.toString() : 'NULL'
        const attrs = p.attributes ? `${esc(JSON.stringify(p.attributes))}::jsonb` : 'NULL'
        const lastTested = p.lastTestedAt ? `'${p.lastTestedAt.toISOString()}'` : 'NULL'
        const lastSeen = p.lastSeenOnlineAt ? `'${p.lastSeenOnlineAt.toISOString()}'` : 'NULL'

        sqlLines.push(`
INSERT INTO compute_provider (id, address, "providerType", name, verified, blocked, block_reason, is_online, last_seen_online_at, gpu_models, gpu_available, gpu_total, min_price_uact, max_price_uact, attributes, last_tested_at, "createdAt", "updatedAt")
VALUES (
  ${esc(p.id)}, ${esc(p.address)}, ${esc(p.providerType)}, ${esc(p.name)}, ${p.verified}, ${p.blocked}, ${esc(p.blockReason)},
  ${p.isOnline}, ${lastSeen}, ${gpuModelsArr}, ${p.gpuAvailable}, ${p.gpuTotal},
  ${minPrice}, ${maxPrice}, ${attrs}, ${lastTested},
  '${p.createdAt.toISOString()}', NOW()
)
ON CONFLICT (address) DO UPDATE SET
  verified = EXCLUDED.verified,
  blocked = EXCLUDED.blocked,
  block_reason = EXCLUDED.block_reason,
  is_online = EXCLUDED.is_online,
  last_seen_online_at = EXCLUDED.last_seen_online_at,
  gpu_models = EXCLUDED.gpu_models,
  gpu_available = EXCLUDED.gpu_available,
  gpu_total = EXCLUDED.gpu_total,
  min_price_uact = EXCLUDED.min_price_uact,
  max_price_uact = EXCLUDED.max_price_uact,
  attributes = EXCLUDED.attributes,
  last_tested_at = EXCLUDED.last_tested_at,
  "updatedAt" = NOW();`)
      }

      // Template results: look up provider by address in remote DB
      for (const tr of templateResults) {
        const providerAddr = tr.provider.address
        const priceUact = tr.priceUact !== null ? tr.priceUact.toString() : 'NULL'
        const durationMs = tr.durationMs !== null ? tr.durationMs.toString() : 'NULL'

        sqlLines.push(`
INSERT INTO provider_template_result (id, provider_id, template_id, passed, price_uact, duration_ms, error_message, tested_at)
SELECT ${esc(tr.id)}, cp.id, ${esc(tr.templateId)}, ${tr.passed}, ${priceUact}, ${durationMs}, ${esc(tr.errorMessage)}, '${tr.testedAt.toISOString()}'
FROM compute_provider cp WHERE cp.address = ${esc(providerAddr)} LIMIT 1
ON CONFLICT (provider_id, template_id) DO UPDATE SET
  passed = EXCLUDED.passed,
  price_uact = EXCLUDED.price_uact,
  duration_ms = EXCLUDED.duration_ms,
  error_message = EXCLUDED.error_message,
  tested_at = EXCLUDED.tested_at;`)
      }

      sqlLines.push('COMMIT;')

      // Summary query
      sqlLines.push(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE verified = true) as verified FROM compute_provider;`)

      const sqlContent = sqlLines.join('\n')
      const tmpFile = join(tmpdir(), `af-sync-${env.name}-${Date.now()}.sql`)
      writeFileSync(tmpFile, sqlContent, 'utf-8')
      console.log(`  Generated ${sqlLines.length} SQL statements (${(sqlContent.length / 1024).toFixed(1)} KB)`)

      try {
        // Pipe SQL file through kubectl exec
        const cmd = `KUBECONFIG=${KUBECONFIG} kubectl exec -i postgres-0 -n ${env.namespace} -- psql -U alternatefutures -d ${env.database} < "${tmpFile}" 2>&1 | tail -5`
        console.log(`  Executing on ${env.name}...`)
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 })
        console.log(`  ${output.trim()}`)
        console.log(`  ✓ Sync to ${env.name} complete`)
      } catch (e: any) {
        console.error(`  ✗ Sync to ${env.name} failed: ${(e.stderr || e.message || '').slice(0, 500)}`)
      } finally {
        try { unlinkSync(tmpFile) } catch {}
      }
    }
  } finally {
    await prisma.$disconnect()
  }

  console.log('\nSync complete.')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
