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

async function pullFromProduction() {
  console.log('Pulling provider data from production into local DB...\n')
  const prisma = new PrismaClient()

  try {
    const prodEnv = ENVS.find(e => e.name === 'production')!

    // Pull compute_provider rows as JSON from production
    const selectProviders = `SELECT json_agg(row_to_json(t)) FROM (SELECT address, "providerType", name, verified, blocked, block_reason, is_online, last_seen_online_at, gpu_models, gpu_available, gpu_total, min_price_uact, max_price_uact, attributes, last_tested_at FROM compute_provider WHERE last_tested_at IS NOT NULL OR gpu_total > 0 OR verified = true ORDER BY address) t`
    const providerCmd = `KUBECONFIG=${KUBECONFIG} kubectl exec -i postgres-0 -n ${prodEnv.namespace} -- psql -U alternatefutures -d ${prodEnv.database} -t -A -c "${selectProviders}" 2>&1`
    console.log('  Fetching providers from production...')
    const providerJson = execSync(providerCmd, { encoding: 'utf-8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }).trim()

    if (!providerJson || providerJson === '' || providerJson === 'null') {
      console.log('  No providers found in production.')
      return
    }

    const providers = JSON.parse(providerJson) as any[]
    console.log(`  Found ${providers.length} provider(s) in production`)

    for (const p of providers) {
      await prisma.computeProvider.upsert({
        where: { address: p.address },
        create: {
          address: p.address,
          providerType: p.providerType,
          name: p.name,
          verified: p.verified,
          blocked: p.blocked,
          blockReason: p.block_reason,
          isOnline: p.is_online,
          lastSeenOnlineAt: p.last_seen_online_at ? new Date(p.last_seen_online_at) : null,
          gpuModels: p.gpu_models || [],
          gpuAvailable: p.gpu_available || 0,
          gpuTotal: p.gpu_total || 0,
          minPriceUact: p.min_price_uact != null ? BigInt(p.min_price_uact) : null,
          maxPriceUact: p.max_price_uact != null ? BigInt(p.max_price_uact) : null,
          attributes: p.attributes ?? null,
          lastTestedAt: p.last_tested_at ? new Date(p.last_tested_at) : null,
        },
        update: {
          verified: p.verified,
          blocked: p.blocked,
          blockReason: p.block_reason,
          isOnline: p.is_online,
          lastSeenOnlineAt: p.last_seen_online_at ? new Date(p.last_seen_online_at) : null,
          gpuModels: p.gpu_models || [],
          gpuAvailable: p.gpu_available || 0,
          gpuTotal: p.gpu_total || 0,
          minPriceUact: p.min_price_uact != null ? BigInt(p.min_price_uact) : null,
          maxPriceUact: p.max_price_uact != null ? BigInt(p.max_price_uact) : null,
          attributes: p.attributes ?? null,
          lastTestedAt: p.last_tested_at ? new Date(p.last_tested_at) : null,
        },
      })
    }
    console.log(`  ✓ Upserted ${providers.length} providers into local DB`)

    // Pull template results
    const selectResults = `SELECT json_agg(row_to_json(t)) FROM (SELECT ptr.template_id, ptr.passed, ptr.price_uact, ptr.duration_ms, ptr.error_message, ptr.tested_at, cp.address as provider_address FROM provider_template_result ptr JOIN compute_provider cp ON cp.id = ptr.provider_id) t`
    const resultsCmd = `KUBECONFIG=${KUBECONFIG} kubectl exec -i postgres-0 -n ${prodEnv.namespace} -- psql -U alternatefutures -d ${prodEnv.database} -t -A -c "${selectResults}" 2>&1`
    console.log('  Fetching template results from production...')
    const resultsJson = execSync(resultsCmd, { encoding: 'utf-8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }).trim()

    if (resultsJson && resultsJson !== '' && resultsJson !== 'null') {
      const tResults = JSON.parse(resultsJson) as any[]
      console.log(`  Found ${tResults.length} template result(s)`)

      for (const tr of tResults) {
        const localProvider = await prisma.computeProvider.findUnique({
          where: { address: tr.provider_address },
          select: { id: true },
        })
        if (!localProvider) continue

        await prisma.providerTemplateResult.upsert({
          where: { providerId_templateId: { providerId: localProvider.id, templateId: tr.template_id } },
          create: {
            providerId: localProvider.id,
            templateId: tr.template_id,
            passed: tr.passed,
            priceUact: tr.price_uact != null ? BigInt(tr.price_uact) : null,
            durationMs: tr.duration_ms,
            errorMessage: tr.error_message,
            testedAt: new Date(tr.tested_at),
          },
          update: {
            passed: tr.passed,
            priceUact: tr.price_uact != null ? BigInt(tr.price_uact) : null,
            durationMs: tr.duration_ms,
            errorMessage: tr.error_message,
            testedAt: new Date(tr.tested_at),
          },
        })
      }
      console.log(`  ✓ Upserted ${tResults.length} template results into local DB`)
    }

    const verified = await prisma.computeProvider.count({ where: { verified: true } })
    console.log(`\n  Pull complete. Local DB now has ${verified} verified provider(s).`)
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const stagingOnly = args.includes('--staging-only')
  const prodOnly = args.includes('--prod-only')
  const pullFromProd = args.includes('--pull-from-prod')

  if (pullFromProd) {
    await pullFromProduction()
    return
  }

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
