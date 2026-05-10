#!/usr/bin/env npx tsx
/**
 * Spheron API smoke test (Phase A — pre-Phase-C validation).
 *
 * Exercises the SpheronClient + cloudInit builder + SSH bootstrap end-to-end
 * against the live Spheron API. Bypasses the orchestrator's DB row creation
 * (no Service / OrgBilling / Policy fixtures needed) so this is the cheapest
 * way to confirm:
 *
 *   1. SPHERON_API_KEY + SPHERON_TEAM_ID resolve a real team with balance.
 *   2. The platform SSH key is registered (or registers cleanly) on Spheron.
 *   3. cloudInit lays down a working compose file + brings Docker up on
 *      the cheapest available DEDICATED GPU offer.
 *   4. We can SSH to the resulting VM and `docker ps` shows running containers.
 *   5. DELETE cleans up cleanly (no leaked $$ on the team balance).
 *
 * Cost: ~$0.05–$0.20 depending on cheapest offer. Always terminates within
 *       2 minutes of provisioning. If you Ctrl-C mid-flight, run again
 *       with `--clean-only --deployment-id <id>` to remove the stranded VM.
 *
 * Usage:
 *   pnpm --filter @alternatefutures/backend exec tsx scripts/spheron-api-smoke.ts
 *   # or:
 *   cd service-cloud-api && npx tsx scripts/spheron-api-smoke.ts
 *
 *   # Skip provisioning, just probe credentials + key bootstrap:
 *   npx tsx scripts/spheron-api-smoke.ts --no-deploy
 *
 *   # Tear down a stranded VM:
 *   npx tsx scripts/spheron-api-smoke.ts --clean-only --deployment-id <spheron-id>
 *
 * Exit codes:
 *   0 — all probes succeeded
 *   1 — credential / config failure (no $$ spent)
 *   2 — deploy succeeded but probe / cleanup failed (CHECK SPHERON DASHBOARD
 *       FOR LEAKED VM and tear it down manually)
 */

import 'dotenv/config'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  getSpheronClient,
  resetSpheronClient,
  type SpheronGpuOffer,
} from '../src/services/spheron/client.js'
import { buildCloudInit } from '../src/services/spheron/cloudInit.js'
import {
  getSpheronSshKeyPath,
} from '../src/services/spheron/orchestrator.js'
import {
  startSpheronSshKeyBootstrap,
  resetCachedSpheronSshKeyId,
} from '../src/services/providers/spheronSshKeyBootstrap.js'

interface CliFlags {
  noDeploy: boolean
  cleanOnly: boolean
  deploymentId: string | null
  composeImage: string
  composeContainerPort: number
}

function parseArgs(): CliFlags {
  const args = process.argv.slice(2)
  let noDeploy = false
  let cleanOnly = false
  let deploymentId: string | null = null
  let composeImage = 'nginx:alpine'
  let composeContainerPort = 80

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--no-deploy') noDeploy = true
    else if (a === '--clean-only') cleanOnly = true
    else if (a === '--deployment-id') deploymentId = args[++i]
    else if (a === '--compose-image') composeImage = args[++i]
    else if (a === '--compose-container-port') composeContainerPort = Number(args[++i])
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: npx tsx scripts/spheron-api-smoke.ts [--no-deploy] [--clean-only --deployment-id <id>] [--compose-image <image>] [--compose-container-port <port>]'
      )
      process.exit(0)
    }
  }

  return { noDeploy, cleanOnly, deploymentId, composeImage, composeContainerPort }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`
}

async function pickCheapestDedicatedOffer(): Promise<{ offer: SpheronGpuOffer; gpuType: string }> {
  const client = getSpheronClient()!
  console.log('\n[3] Fetching cheapest DEDICATED GPU offers...')
  const res = await client.listGpuOffers({
    sortBy: 'lowestPrice',
    sortOrder: 'asc',
    limit: 25,
    instanceType: 'DEDICATED',
  })

  // Carry the parent group's gpuType — required by Spheron's createDeployment.
  // The API rejects 'unknown'/mismatched values: "omit it or pass the offer's gpuType."
  const allOffers = res.data.flatMap(g =>
    g.offers
      .filter(o => o.available)
      .map(offer => ({ offer, gpuType: g.gpuType })),
  )
  if (allOffers.length === 0) {
    throw new Error('No available DEDICATED offers across the entire Spheron catalogue')
  }
  // Filter for cloudInit-supporting offers ONLY — Phase A's compose model
  // depends on cloudInit, no point booting an offer that can't run it.
  const usable = allOffers.filter(p => p.offer.supportsCloudInit && p.offer.os_options.length > 0)
  if (usable.length === 0) {
    throw new Error('No cloudInit-capable DEDICATED offers — Spheron catalogue may have shifted')
  }
  // listGpuOffers already sorted lowest-price first; preserve that ordering,
  // but the filter pass may have skipped cheap entries — re-sort for safety.
  usable.sort((a, b) => a.offer.price - b.offer.price)
  const pick = usable[0]
  console.log(
    `    → cheapest cloudInit-capable: ${pick.offer.provider} / ${pick.offer.name} ` +
    `(gpuType=${pick.gpuType}, ${pick.offer.gpuCount}× GPU, ${pick.offer.gpu_memory}GB VRAM each, ${pick.offer.vcpus} vCPU, ${pick.offer.memory}GB RAM, ${pick.offer.storage}GB)`
  )
  console.log(
    `    → price: ${fmtUsd(pick.offer.price)}/hr, region(s): ${pick.offer.clusters.join(', ')}, ` +
    `OS choices: ${pick.offer.os_options.length}`
  )
  return pick
}

function pickPreinstalledOsOrFallback(offer: SpheronGpuOffer): string {
  // Prefer Docker-baked images (data-crunch ships these) — saves the
  // 60-90s apt install at boot.
  const baked = offer.os_options.find(o => /\bdocker\b/i.test(o))
  if (baked) return baked
  // Fallback: anything with "ubuntu" in the name.
  const ubuntu = offer.os_options.find(o => /\bubuntu\b/i.test(o))
  return ubuntu ?? offer.os_options[0]
}

function buildSmokeCompose(image: string, containerPort: number): string {
  return [
    'services:',
    '  smoke:',
    `    image: ${image}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${containerPort}:${containerPort}"`,
    '',
  ].join('\n')
}

async function probeViaSsh(
  ipAddress: string,
  user: string,
  port: number,
  retries = 12,
  intervalMs = 5000,
): Promise<{ ok: boolean; output: string }> {
  const keyPath = getSpheronSshKeyPath()
  if (!existsSync(keyPath)) {
    return { ok: false, output: `SSH private key missing at ${keyPath}` }
  }

  const sshArgs = [
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=10',
    '-p', String(port),
    `${user}@${ipAddress}`,
    "docker ps --no-trunc --format '{{.Names}}\t{{.State}}\t{{.Status}}' 2>&1 || true",
  ]

  for (let i = 1; i <= retries; i++) {
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
      child.on('close', code => resolve({ code, stdout, stderr }))
      child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + (err as Error).message }))
    })

    const combined = (out.stdout + (out.stderr ? '\n[stderr] ' + out.stderr : '')).trim()
    if (out.code === 0 && /\b(running|up)\b/i.test(combined)) {
      return { ok: true, output: combined }
    }
    if (i === retries) {
      return { ok: false, output: combined || `ssh exit code ${out.code}` }
    }
    console.log(`    ssh attempt ${i}/${retries} not ready yet — retrying in ${intervalMs / 1000}s`)
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return { ok: false, output: 'unreachable' }
}

async function main(): Promise<void> {
  const flags = parseArgs()

  // ── Step 1 — credentials + balance ──────────────────────────────
  console.log('[1] Resolving SpheronClient from env...')
  resetSpheronClient()
  resetCachedSpheronSshKeyId()
  const client = getSpheronClient()
  if (!client) {
    console.error('  ✗ SPHERON_API_KEY missing or empty in .env — aborting')
    process.exit(1)
  }
  console.log(`    ✓ SpheronClient ready (teamId env: ${process.env.SPHERON_TEAM_ID ?? '(unset)'} )`)

  const team = await client.getCurrentTeamBalance()
  if (!team) {
    console.error('  ✗ getCurrentTeamBalance returned null — API key may be invalid or team revoked')
    process.exit(1)
  }
  console.log(`    ✓ team "${team.teamName}" (${team.teamId}) balance = ${fmtUsd(team.balance)} USD`)
  if (team.balance < 1) {
    console.error('  ✗ team balance < $1 — top up before running smoke test')
    process.exit(1)
  }

  // ── Step 2 — SSH bootstrap ──────────────────────────────────────
  console.log('\n[2] Running SSH key bootstrap...')
  const sshKeyId = await startSpheronSshKeyBootstrap()
  if (!sshKeyId) {
    console.error('  ✗ SSH bootstrap returned null — check ~/.ssh/af_spheron_ed25519.pub exists and SPHERON_SSH_KEY_NAME is set')
    process.exit(1)
  }
  console.log(`    ✓ resolved sshKeyId = ${sshKeyId}`)

  // ── Clean-only path ─────────────────────────────────────────────
  if (flags.cleanOnly) {
    if (!flags.deploymentId) {
      console.error('  ✗ --clean-only requires --deployment-id <id>')
      process.exit(1)
    }
    console.log(`\n[*] Cleanup-only mode — DELETE ${flags.deploymentId}`)
    try {
      await client.deleteDeployment(flags.deploymentId)
      console.log('    ✓ DELETE OK')
      process.exit(0)
    } catch (err) {
      console.error('  ✗ DELETE failed:', err)
      process.exit(2)
    }
  }

  if (flags.noDeploy) {
    console.log('\n[!] --no-deploy set — skipping provisioning, all credential checks passed')
    process.exit(0)
  }

  // ── Step 3 — pick offer ─────────────────────────────────────────
  const { offer, gpuType } = await pickCheapestDedicatedOffer()
  const operatingSystem = pickPreinstalledOsOrFallback(offer)
  const region = offer.clusters[0]
  console.log(`    → using OS = "${operatingSystem}", region = "${region}"`)

  // ── Step 4 — build cloudInit ───────────────────────────────────
  console.log('\n[4] Building cloudInit (compose:', flags.composeImage, '→ port', flags.composeContainerPort + ')...')
  const cloudInit = buildCloudInit({
    composeContent: buildSmokeCompose(flags.composeImage, flags.composeContainerPort),
    envVars: {},
    operatingSystem,
  })
  console.log(`    ✓ packages=${(cloudInit.packages ?? []).length}, writeFiles=${(cloudInit.writeFiles ?? []).length}, runcmd=${(cloudInit.runcmd ?? []).length}`)

  // ── Step 5 — POST /api/deployments ─────────────────────────────
  const deployName = `af-smoke-${Date.now().toString(36)}`
  console.log('\n[5] POSTing deploy to Spheron...')
  const created = await client.createDeployment({
    provider: offer.provider,
    offerId: offer.offerId,
    gpuType,
    gpuCount: offer.gpuCount,
    region,
    operatingSystem,
    instanceType: 'DEDICATED',
    sshKeyId,
    name: deployName,
    cloudInit,
  })
  console.log(`    ✓ deployment id = ${created.id} (status: ${created.status})`)

  let providerDeploymentId = created.id
  let cleanedUp = false
  const cleanup = async (reason: string) => {
    if (cleanedUp) return
    cleanedUp = true
    console.log(`\n[*] Cleaning up (${reason})...`)
    try {
      await client.deleteDeployment(providerDeploymentId)
      console.log('    ✓ DELETE OK — VM torn down')
    } catch (err) {
      console.error('  ✗ DELETE FAILED — manually clean up:', providerDeploymentId, err)
    }
  }

  // SIGINT / unexpected exit safety net.
  const onExit = () => { cleanup('signal').then(() => process.exit(2)) }
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)

  try {
    // ── Step 6 — poll for running + ipAddress ───────────────────
    console.log('\n[6] Polling for running + ipAddress (max ~10 min)...')
    const start = Date.now()
    const POLL_INTERVAL = 5_000
    const POLL_MAX = 120
    let live: Awaited<ReturnType<typeof client.getDeployment>> | null = null
    for (let attempt = 1; attempt <= POLL_MAX; attempt++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      live = await client.getDeployment(providerDeploymentId)
      const elapsedSec = Math.round((Date.now() - start) / 1000)
      console.log(`    attempt ${attempt}/${POLL_MAX} (${elapsedSec}s): status=${live.status} ip=${live.ipAddress ?? '—'} sshPort=${live.sshPort ?? '—'}`)
      if (live.status === 'running' && live.ipAddress) break
      if (live.status === 'failed' || live.status === 'terminated' || live.status === 'terminated-provider') {
        throw new Error(`Spheron returned terminal status ${live.status} — aborting smoke`)
      }
    }
    if (!live || live.status !== 'running' || !live.ipAddress) {
      throw new Error('VM did not reach running state within ~10 min — aborting')
    }
    console.log(`    ✓ VM up at ${live.user ?? 'ubuntu'}@${live.ipAddress}:${live.sshPort ?? 22}`)

    // ── Step 7 — SSH probe for docker ps ────────────────────────
    console.log('\n[7] Probing docker via SSH (apt+pull may take a few minutes)...')
    const probe = await probeViaSsh(live.ipAddress, live.user ?? 'ubuntu', live.sshPort ?? 22, 36, 10_000)
    if (!probe.ok) {
      console.error('  ✗ SSH probe never saw a running container. Last output:\n' + probe.output)
      throw new Error('Container health probe failed')
    }
    console.log('    ✓ containers running:\n' + probe.output.split('\n').map(l => '      ' + l).join('\n'))

    console.log('\n[✓] All probes passed — Spheron Phase A wiring works end-to-end')
  } catch (err) {
    console.error('\n[✗] Smoke test failed:', err instanceof Error ? err.message : err)
    await cleanup('test failure')
    process.exit(2)
  }

  // ── Step 8 — DELETE ─────────────────────────────────────────────
  await cleanup('test complete')
  process.exit(0)
}

main().catch(err => {
  console.error('\n[!] Unhandled error:', err)
  process.exit(1)
})
