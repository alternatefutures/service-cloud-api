#!/usr/bin/env bun
/**
 * Seed the compute_provider table from the existing preferred-providers.json
 * and the hardcoded BLOCKED_PROVIDERS list.
 *
 * Run once after the migration to bootstrap the DB with existing data:
 *   cd service-cloud-api && bun scripts/seed-provider-registry.ts
 *
 * Safe to re-run — uses upsert so it won't create duplicates.
 */

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import { resolve } from 'path'

interface PreferredEntry {
  address: string
  name: string
  verified: boolean
  testedAt: string
  templatesPassed: number
  templatesTested: number
  notes: string
}

interface PreferredFile {
  providers: PreferredEntry[]
}

const BLOCKED_PROVIDERS: Record<string, { name: string; reason: string }> = {
  akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040: {
    name: 'AiritDecomp',
    reason: 'Wildcard DNS not configured - ingress URLs do not resolve',
  },
  akash1chnhnu50f6hv98xl0m7xm95vel457ysp32uwpj: {
    name: 'Unknown (chnhnu...)',
    reason: 'Consistently fails to accept manifest submissions',
  },
  akash1swxj75e8tz2nuepnqdas787h3eqfmhyh8lak8g: {
    name: 'DataNode UK',
    reason: 'Extremely slow ingress setup - URIs not available for 5+ minutes',
  },
  akash1sjwuwre4qprcaa34f6324yz7m8nn0awvc75gp5: {
    name: 'quanglong.org',
    reason: 'Repeated kube: lease not found after manifest; 502 Bad Gateway',
  },
  akash18zskyywdy4ng50dd9yjen8daep0z585mc296h4: {
    name: 'ouroboroz.tech',
    reason: 'Nginx ingress returns persistent 502 despite healthy containers',
  },
  akash1ut3m97h62tty06qdq9lds85r34dxe3snjj0xfe: {
    name: 'Unknown (ut3m...)',
    reason: 'Accepts bids but containers never start — 0 replicas, no URIs',
  },
}

async function main() {
  const prisma = new PrismaClient()

  try {
    // Load preferred providers from JSON
    const jsonPath = resolve(import.meta.dir, '../lib/preferred-providers.json')
    let preferredData: PreferredFile = { providers: [] }
    try {
      const raw = readFileSync(jsonPath, 'utf-8')
      preferredData = JSON.parse(raw) as PreferredFile
      console.log(`Loaded ${preferredData.providers.length} provider(s) from preferred-providers.json`)
    } catch {
      console.log('No preferred-providers.json found, skipping preferred import')
    }

    let upserted = 0

    // Seed preferred providers
    for (const p of preferredData.providers) {
      if (!p.address) continue

      const isAlsoBlocked = BLOCKED_PROVIDERS[p.address] !== undefined

      await prisma.computeProvider.upsert({
        where: { address: p.address },
        create: {
          address: p.address,
          providerType: 'AKASH',
          name: p.name || null,
          verified: p.verified && !isAlsoBlocked,
          blocked: isAlsoBlocked,
          blockReason: isAlsoBlocked ? BLOCKED_PROVIDERS[p.address].reason : null,
          lastTestedAt: p.testedAt ? new Date(p.testedAt) : null,
        },
        update: {
          name: p.name || undefined,
          verified: p.verified && !isAlsoBlocked,
          blocked: isAlsoBlocked,
          blockReason: isAlsoBlocked ? BLOCKED_PROVIDERS[p.address].reason : null,
          lastTestedAt: p.testedAt ? new Date(p.testedAt) : undefined,
        },
      })

      const status = isAlsoBlocked ? 'BLOCKED (overrides verified)' : p.verified ? 'VERIFIED' : 'unverified'
      console.log(`  ${p.address.slice(0, 20)}... → ${status} (${p.name})`)
      upserted++
    }

    // Seed blocked providers not already in the preferred list
    for (const [addr, info] of Object.entries(BLOCKED_PROVIDERS)) {
      const exists = preferredData.providers.some(p => p.address === addr)
      if (exists) continue

      await prisma.computeProvider.upsert({
        where: { address: addr },
        create: {
          address: addr,
          providerType: 'AKASH',
          name: info.name,
          verified: false,
          blocked: true,
          blockReason: info.reason,
        },
        update: {
          blocked: true,
          blockReason: info.reason,
        },
      })

      console.log(`  ${addr.slice(0, 20)}... → BLOCKED (${info.name})`)
      upserted++
    }

    const stats = await prisma.computeProvider.groupBy({
      by: ['verified', 'blocked'],
      _count: true,
    })
    console.log(`\nDone. Upserted ${upserted} provider(s).`)
    console.log('Current DB state:')
    for (const s of stats) {
      console.log(`  verified=${s.verified} blocked=${s.blocked}: ${s._count} provider(s)`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
