#!/usr/bin/env bun
/**
 * End-to-end Akash deployment test tool.
 *
 * Runs the full deployment lifecycle directly via the akash / provider-services
 * CLI — no cloud-api server required. Prints every command, its raw output,
 * parsed results, and timing so the AI assistant (or a human) can diagnose
 * deployment issues with zero guesswork.
 *
 * Usage:
 *   bun scripts/test-deploy.ts deploy <template-id> [--close] [--provider <addr>] [--env KEY=VAL ...]
 *   bun scripts/test-deploy.ts test-all [--no-gpu] [--provider <addr>]
 *   bun scripts/test-deploy.ts status <dseq> --provider <addr>
 *   bun scripts/test-deploy.ts logs   <dseq> --provider <addr> [--service name] [--tail N]
 *   bun scripts/test-deploy.ts close  <dseq>
 *   bun scripts/test-deploy.ts probe  <url>
 *   bun scripts/test-deploy.ts list-templates
 */

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// ── Load env from admin/cloud/secrets/.env.local ──────────────────────

const ENV_PATH = resolve(
  import.meta.dir,
  '../../admin/cloud/secrets/.env.local'
)

function loadEnvFile(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    console.error(`[env] Could not read ${path}`)
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx)
    let val = trimmed.slice(eqIdx + 1)
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

loadEnvFile(ENV_PATH)

// Also load service-cloud-api/.env for DATABASE_URL etc.
loadEnvFile(resolve(import.meta.dir, '../.env'))

// ── Import template system (pure functions, no side effects) ──────────

import { getTemplateById, getAllTemplates } from '../src/templates/registry.js'
import { generateSDLFromTemplate } from '../src/templates/sdl.js'

// ── Constants ─────────────────────────────────────────────────────────

const BID_POLL_MAX = 12
const BID_POLL_DELAY_BASE_MS = 5_000
const URL_POLL_MAX = 24
const URL_POLL_DELAY_MS = 5_000
const CLI_TIMEOUT_MS = 120_000

// ── Akash env (mirrors orchestrator.ts getAkashEnv) ───────────────────

function getAkashEnv(): Record<string, string> {
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  return {
    ...(process.env as Record<string, string>),
    AKASH_KEY_NAME: keyName,
    AKASH_FROM: keyName,
    AKASH_KEYRING_BACKEND: 'test',
    AKASH_NODE: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
    AKASH_CHAIN_ID: process.env.AKASH_CHAIN_ID || 'akashnet-2',
    AKASH_GAS: 'auto',
    AKASH_GAS_ADJUSTMENT: '1.5',
    AKASH_GAS_PRICES: '0.025uakt',
    AKASH_BROADCAST_MODE: 'block',
    AKASH_YES: 'true',
    HOME: process.env.HOME || '/home/nodejs',
  }
}

// ── CLI helpers ───────────────────────────────────────────────────────

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  command: string
}

function execCli(
  bin: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS
): Promise<ExecResult> {
  const env = getAkashEnv()
  const command = `${bin} ${args.join(' ')}`
  const start = Date.now()
  return new Promise(res => {
    execFile(
      bin,
      args,
      { encoding: 'utf-8', env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start
        const exitCode = err ? (err as any).code ?? 1 : 0
        res({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, durationMs, command })
      }
    )
  })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch { /* continue */ }

  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
  if (startIdx === -1) throw new SyntaxError(`No JSON in output: ${trimmed.slice(0, 200)}`)
  return JSON.parse(trimmed.slice(startIdx))
}

// ── Logging ───────────────────────────────────────────────────────────

type StepStatus = 'OK' | 'FAIL' | 'TIMEOUT' | 'SKIP'

interface StepResult {
  step: string
  status: StepStatus
  durationMs: number
  detail: string
}

const stepResults: StepResult[] = []

function banner(step: string, description: string) {
  const line = '═'.repeat(70)
  console.log(`\n${line}`)
  console.log(`  ${step}: ${description}`)
  console.log(line)
}

function logCmd(r: ExecResult) {
  console.log(`  $ ${r.command}`)
  console.log(`  exit=${r.exitCode}  duration=${r.durationMs}ms`)
  if (r.stderr.trim()) {
    console.log(`  ── stderr ──`)
    console.log(indent(r.stderr.trim(), 4))
  }
  if (r.stdout.trim()) {
    const lines = r.stdout.trim().split('\n')
    if (lines.length > 80) {
      console.log(`  ── stdout (${lines.length} lines, showing first 80) ──`)
      console.log(indent(lines.slice(0, 80).join('\n'), 4))
      console.log(`    ... (${lines.length - 80} more lines)`)
    } else {
      console.log(`  ── stdout ──`)
      console.log(indent(r.stdout.trim(), 4))
    }
  }
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n)
  return text.split('\n').map(l => pad + l).join('\n')
}

function recordStep(step: string, status: StepStatus, durationMs: number, detail: string) {
  stepResults.push({ step, status, durationMs, detail })
  const icon = status === 'OK' ? '[OK]' : status === 'FAIL' ? '[FAIL]' : status === 'TIMEOUT' ? '[TIMEOUT]' : '[SKIP]'
  console.log(`\n  ${icon} ${step} (${durationMs}ms) — ${detail}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Probe helpers ─────────────────────────────────────────────────────

async function probeHttp(uri: string): Promise<{ ok: boolean; status?: number; durationMs: number; error?: string }> {
  const candidates = uri.startsWith('http://') || uri.startsWith('https://')
    ? [uri]
    : [`https://${uri}`, `http://${uri}`]

  for (const url of candidates) {
    const start = Date.now()
    try {
      const resp = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) })
      return { ok: resp.status < 500, status: resp.status, durationMs: Date.now() - start }
    } catch (e: any) {
      const durationMs = Date.now() - start
      if (url === candidates[candidates.length - 1]) {
        return { ok: false, durationMs, error: e.message?.slice(0, 200) }
      }
    }
  }
  return { ok: false, durationMs: 0, error: 'no candidates' }
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const start = Date.now()
  return new Promise(res => {
    const sock = connect({ host, port, timeout: 5000 }, () => {
      sock.destroy()
      res({ ok: true, durationMs: Date.now() - start })
    })
    sock.on('error', (e: any) => {
      sock.destroy()
      res({ ok: false, durationMs: Date.now() - start, error: e.message })
    })
    sock.on('timeout', () => {
      sock.destroy()
      res({ ok: false, durationMs: Date.now() - start, error: 'timeout' })
    })
  })
}

function isLikelyTcp(uri: string): boolean {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return false
  const parts = uri.split(':')
  if (parts.length < 2) return false
  const port = Number(parts.at(-1))
  if (Number.isNaN(port)) return false
  return port !== 80 && port !== 443
}

// ── DEPLOY command ────────────────────────────────────────────────────

interface DeployResult {
  templateId: string
  templateName: string
  image: string
  passed: boolean
  dseq?: number
  owner?: string
  provider?: string
  priceUakt?: string
  totalMs: number
  steps: StepResult[]
  endpoints?: Record<string, string[]>
  error?: string
}

async function cmdDeploy(templateId: string, opts: { close: boolean; envOverrides: Record<string, string>; preferProvider?: string }): Promise<DeployResult> {
  const totalStart = Date.now()
  stepResults.length = 0

  if (!process.env.AKASH_MNEMONIC) {
    console.error('AKASH_MNEMONIC is not set. Check admin/cloud/secrets/.env.local')
    process.exit(1)
  }

  // ── Step 0: Load template + generate SDL ────────────────────────
  banner('STEP 0', `Load template "${templateId}" and generate SDL`)

  const template = getTemplateById(templateId)
  if (!template) {
    console.error(`Template "${templateId}" not found. Available:`)
    for (const t of getAllTemplates()) console.error(`  - ${t.id} (${t.name})`)
    process.exit(1)
  }

  console.log(`  Template: ${template.name} (${template.category})`)
  console.log(`  Image:    ${template.dockerImage}`)
  console.log(`  Ports:    ${template.ports.map(p => `${p.port}→${p.as}`).join(', ')}`)

  // Auto-fill required secret env vars that have no default
  const autoEnv: Record<string, string> = {}
  for (const v of template.envVars) {
    if (v.default === null && v.required && !opts.envOverrides[v.key]) {
      const generated = randomBytes(16).toString('base64url')
      autoEnv[v.key] = generated
      console.log(`  Auto-generated ${v.key} = ${generated}`)
    }
  }

  const sdl = generateSDLFromTemplate(template, {
    serviceName: `test-${templateId}`,
    envOverrides: { ...autoEnv, ...opts.envOverrides },
  })

  console.log(`\n  ── Generated SDL ──`)
  console.log(indent(sdl, 4))

  const workDir = mkdtempSync(join(tmpdir(), 'af-test-deploy-'))
  const sdlPath = join(workDir, 'deploy.yaml')
  writeFileSync(sdlPath, sdl)
  console.log(`  SDL written to: ${sdlPath}`)
  recordStep('GENERATE_SDL', 'OK', Date.now() - totalStart, `Template ${templateId} → SDL`)

  let dseq: number | undefined
  let owner: string | undefined
  let provider: string | undefined
  let priceAmount: string | undefined
  let gseq = 1
  let oseq = 1
  let serviceUrls: Record<string, string[]> = {}

  const mkResult = (): DeployResult => ({
    templateId,
    templateName: template?.name ?? templateId,
    image: template?.dockerImage ?? 'unknown',
    passed: stepResults.length > 0 && stepResults.every(r => r.status === 'OK'),
    dseq, owner, provider,
    priceUakt: priceAmount,
    totalMs: Date.now() - totalStart,
    steps: [...stepResults],
    endpoints: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
  })

  try {
    // ── Step 1: Get owner address ───────────────────────────────
    banner('STEP 1a', 'Get wallet address')
    const addrResult = await execCli('akash', ['keys', 'show', process.env.AKASH_KEY_NAME || 'default', '-a'], 15_000)
    logCmd(addrResult)
    if (addrResult.exitCode !== 0) {
      recordStep('GET_ADDRESS', 'FAIL', addrResult.durationMs, addrResult.stderr.trim())
      return mkResult()
    }
    owner = addrResult.stdout.trim()
    console.log(`\n  Owner: ${owner}`)
    recordStep('GET_ADDRESS', 'OK', addrResult.durationMs, owner)

    // Check balance
    banner('STEP 1b', 'Check wallet balance')
    const balResult = await execCli('akash', ['query', 'bank', 'balances', owner, '-o', 'json'], 15_000)
    logCmd(balResult)
    if (balResult.exitCode === 0) {
      try {
        const balJson = extractJson(balResult.stdout) as any
        const balances = balJson.balances || []
        const uakt = balances.find((b: any) => b.denom === 'uakt')
        const akt = uakt ? parseInt(uakt.amount) / 1_000_000 : 0
        console.log(`\n  Balance: ${akt.toFixed(6)} AKT (${uakt?.amount || 0} uakt)`)
        if (akt < 0.5) {
          console.warn('  WARNING: Balance is very low, deployment may fail')
        }
        recordStep('CHECK_BALANCE', 'OK', balResult.durationMs, `${akt.toFixed(6)} AKT`)
      } catch {
        recordStep('CHECK_BALANCE', 'FAIL', balResult.durationMs, 'Failed to parse balance')
      }
    }

    // ── Step 2: Submit deployment tx ─────────────────────────────
    banner('STEP 2', 'Submit deployment transaction')
    const deposit = 5_000_000
    let txResult!: ExecResult
    let txJson: any = {}
    const TX_RETRIES = 3
    for (let txAttempt = 1; txAttempt <= TX_RETRIES; txAttempt++) {
      txResult = await execCli('akash', [
        'tx', 'deployment', 'create', sdlPath,
        '--deposit', `${deposit}uakt`,
        '-o', 'json', '-y',
      ])
      logCmd(txResult)
      if (txResult.exitCode !== 0) {
        recordStep('SUBMIT_TX', 'FAIL', txResult.durationMs, txResult.stderr.trim().slice(0, 200))
        return mkResult()
      }
      try { txJson = extractJson(txResult.stdout) as any } catch { txJson = {} }
      const code32 = (typeof txJson.code === 'number' ? txJson.code : parseInt(txJson.code ?? '0', 10)) === 32
      if (code32 && txAttempt < TX_RETRIES) {
        console.log(`\n  Sequence mismatch (code 32), retrying in 8s... (${txAttempt}/${TX_RETRIES})`)
        await sleep(8_000)
        continue
      }
      const txCode = typeof txJson.code === 'number' ? txJson.code : parseInt(txJson.code ?? '0', 10)
      if (txCode !== 0) {
        const rawLog = txJson.raw_log || txJson.rawLog || ''
        recordStep('SUBMIT_TX', 'FAIL', txResult.durationMs, `tx rejected (code ${txCode}): ${rawLog.slice(0, 200)}`)
        return mkResult()
      }
      break
    }

    try {
      // Extract dseq from logs
      const logs = txJson.logs as any[] | undefined
      if (logs) {
        for (const log of logs) {
          for (const event of log.events || []) {
            const attr = event.attributes?.find((a: any) => a.key === 'dseq')
            if (attr) { dseq = parseInt(attr.value, 10); break }
          }
          if (dseq) break
        }
      }

      // If dseq not in logs, poll for confirmed tx
      if (!dseq && txJson.txhash) {
        console.log(`\n  txhash: ${txJson.txhash} — polling for confirmation...`)
        const delays = [8000, 6000, 6000, 8000, 8000]
        for (const delay of delays) {
          await sleep(delay)
          const qr = await execCli('akash', ['query', 'tx', txJson.txhash, '-o', 'json'], 60_000)
          if (qr.exitCode === 0) {
            try {
              const qj = extractJson(qr.stdout) as any
              const qLogs = qj.logs as any[] | undefined
              if (qLogs) {
                for (const log of qLogs) {
                  for (const event of log.events || []) {
                    const attr = event.attributes?.find((a: any) => a.key === 'dseq')
                    if (attr) { dseq = parseInt(attr.value, 10); break }
                  }
                  if (dseq) break
                }
              }
              if (!dseq) {
                const msgDseq = qj.tx?.body?.messages?.[0]?.id?.dseq
                if (msgDseq) dseq = parseInt(msgDseq, 10)
              }
              if (dseq) {
                console.log(`  Confirmed on-chain. dseq=${dseq}`)
                break
              }
            } catch { /* retry */ }
          }
        }
      }

      if (!dseq || isNaN(dseq) || dseq <= 0) {
        recordStep('SUBMIT_TX', 'FAIL', txResult.durationMs, 'Could not extract dseq from tx response')
        return mkResult()
      }

      console.log(`\n  dseq: ${dseq}`)
      recordStep('SUBMIT_TX', 'OK', txResult.durationMs, `dseq=${dseq}`)
    } catch (e: any) {
      recordStep('SUBMIT_TX', 'FAIL', txResult.durationMs, e.message)
      return mkResult()
    }

    // ── Step 3: Poll for bids ───────────────────────────────────
    banner('STEP 3', `Poll for provider bids (max ${BID_POLL_MAX} attempts)`)
    let selectedBid: any = null
    const bidStart = Date.now()

    for (let attempt = 1; attempt <= BID_POLL_MAX; attempt++) {
      const delay = attempt === 1 ? 10_000 : BID_POLL_DELAY_BASE_MS * attempt
      console.log(`\n  Attempt ${attempt}/${BID_POLL_MAX} (waiting ${delay / 1000}s)...`)
      await sleep(delay)

      const bidResult = await execCli('akash', [
        'query', 'market', 'bid', 'list',
        '--owner', owner,
        '--dseq', String(dseq),
        '-o', 'json',
      ])

      if (bidResult.exitCode !== 0) {
        console.log(`  bid list failed: ${bidResult.stderr.trim().slice(0, 200)}`)
        continue
      }

      try {
        const bidJson = extractJson(bidResult.stdout) as any
        const rawBids = bidJson.bids || []
        console.log(`  Received ${rawBids.length} bid(s)`)

        if (rawBids.length === 0) continue

        for (const b of rawBids) {
          const bid = b.bid || b
          const id = bid.bid_id || bid.id || {}
          const price = bid.price || {}
          console.log(`    Provider: ${id.provider}  Price: ${price.amount} ${price.denom}  State: ${bid.state || 'unknown'}`)
        }

        // Select bid: prefer --provider if given, otherwise cheapest
        const openBids = rawBids
          .map((b: any) => {
            const bid = b.bid || b
            const id = bid.bid_id || bid.id || {}
            const price = bid.price || {}
            return {
              provider: String(id.provider || ''),
              gseq: Number(id.gseq || 1),
              oseq: Number(id.oseq || 1),
              amount: String(price.amount || '0'),
              denom: String(price.denom || 'uakt'),
              state: bid.state,
            }
          })
          .filter((b: any) => b.state === 'open')
          .sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))

        if (openBids.length > 0) {
          if (opts.preferProvider) {
            const match = openBids.find((b: any) => b.provider.startsWith(opts.preferProvider!))
            if (match) {
              selectedBid = match
              console.log(`\n  Selected (--provider match): ${selectedBid.provider} at ${selectedBid.amount} ${selectedBid.denom}`)
            } else {
              console.log(`\n  WARNING: --provider ${opts.preferProvider} not among bidders, using cheapest`)
              selectedBid = openBids[0]
              console.log(`  Selected: ${selectedBid.provider} at ${selectedBid.amount} ${selectedBid.denom}`)
            }
          } else {
            selectedBid = openBids[0]
            console.log(`\n  Selected: ${selectedBid.provider} at ${selectedBid.amount} ${selectedBid.denom}`)
          }
          break
        }
        console.log('  No open bids yet, retrying...')
      } catch (e: any) {
        console.log(`  Parse error: ${e.message}`)
      }
    }

    if (!selectedBid) {
      recordStep('CHECK_BIDS', 'FAIL', Date.now() - bidStart, 'No bids received within timeout')
      return mkResult()
    }

    provider = selectedBid.provider
    priceAmount = selectedBid.amount
    gseq = selectedBid.gseq
    oseq = selectedBid.oseq
    recordStep('CHECK_BIDS', 'OK', Date.now() - bidStart, `${selectedBid.provider} @ ${selectedBid.amount} uakt`)

    // ── Step 4: Create lease ──────────────────────────────────────
    banner('STEP 4', 'Create lease')
    let leaseOk = false
    for (let leaseAttempt = 1; leaseAttempt <= TX_RETRIES; leaseAttempt++) {
      const leaseResult = await execCli('akash', [
        'tx', 'market', 'lease', 'create',
        '--dseq', String(dseq),
        '--gseq', String(gseq),
        '--oseq', String(oseq),
        '--provider', provider!,
        '-o', 'json', '-y',
      ])
      logCmd(leaseResult)
      if (leaseResult.exitCode !== 0) {
        recordStep('CREATE_LEASE', 'FAIL', leaseResult.durationMs, leaseResult.stderr.trim().slice(0, 200))
        return mkResult()
      }
      let leaseCode = 0
      try {
        const leaseJson = extractJson(leaseResult.stdout) as any
        leaseCode = leaseJson?.code ?? 0
      } catch { /* non-json is fine */ }
      if (leaseCode === 32 && leaseAttempt < TX_RETRIES) {
        console.log(`\n  Sequence mismatch (code 32), retrying in 8s... (${leaseAttempt}/${TX_RETRIES})`)
        await sleep(8_000)
        continue
      }
      if (leaseCode !== 0) {
        recordStep('CREATE_LEASE', 'FAIL', leaseResult.durationMs, `tx rejected (code ${leaseCode})`)
        return mkResult()
      }
      console.log('\n  Waiting 10s for on-chain confirmation...')
      await sleep(10_000)
      recordStep('CREATE_LEASE', 'OK', leaseResult.durationMs + 10_000, `Lease created with ${provider}`)
      leaseOk = true
      break
    }
    if (!leaseOk) return mkResult()

    // ── Step 5: Send manifest ────────────────────────────────────
    banner('STEP 5', 'Send manifest to provider')
    let manifestOk = false
    const manifestRetries = 3
    for (let attempt = 1; attempt <= manifestRetries; attempt++) {
      const mResult = await execCli('provider-services', [
        'send-manifest', sdlPath,
        '--dseq', String(dseq),
        '--provider', provider!,
      ])
      logCmd(mResult)
      const stderrLower = mResult.stderr.toLowerCase()
      if (mResult.exitCode === 0 && !stderrLower.includes('error')) {
        recordStep('SEND_MANIFEST', 'OK', mResult.durationMs, 'Manifest accepted by provider')
        manifestOk = true
        break
      }
      if (attempt < manifestRetries) {
        const delay = attempt * 5000
        console.log(`\n  Attempt ${attempt}/${manifestRetries} failed, retrying in ${delay / 1000}s...`)
        await sleep(delay)
      } else {
        recordStep('SEND_MANIFEST', 'FAIL', mResult.durationMs, mResult.stderr.trim().slice(0, 200))
      }
    }
    if (!manifestOk) return mkResult()

    // ── Step 6: Poll lease status ─────────────────────────────────
    banner('STEP 6', `Poll lease status (max ${URL_POLL_MAX} attempts, ${URL_POLL_DELAY_MS / 1000}s interval)`)
    console.log('  Waiting 10s for initial container startup...')
    await sleep(10_000)

    serviceUrls = {}
    let deploymentReady = false
    const pollStart = Date.now()

    for (let attempt = 1; attempt <= URL_POLL_MAX; attempt++) {
      const lsResult = await execCli('provider-services', [
        'lease-status',
        '--dseq', String(dseq),
        '--provider', provider!,
      ], 60_000)

      if (lsResult.exitCode !== 0) {
        console.log(`  [${attempt}/${URL_POLL_MAX}] lease-status failed (exit=${lsResult.exitCode}): ${lsResult.stderr.trim().slice(0, 150)}`)
        if (attempt < URL_POLL_MAX) { await sleep(URL_POLL_DELAY_MS); continue }
        break
      }

      try {
        const lsJson = extractJson(lsResult.stdout) as any
        const services = lsJson.services || {}
        const forwardedPorts = lsJson.forwarded_ports || {}

        const svcSummary: string[] = []
        const parsed: Record<string, string[]> = {}
        let hasUris = false
        let hasReplicas = false

        for (const [name, svc] of Object.entries<any>(services)) {
          const uris: string[] = [...(svc.uris || [])]
          if (uris.length === 0 && forwardedPorts[name]?.length) {
            for (const fp of forwardedPorts[name]) {
              uris.push(`${fp.host}:${fp.externalPort}`)
            }
          }
          parsed[name] = uris
          if (uris.length > 0) hasUris = true
          if ((svc.available_replicas ?? 0) > 0) hasReplicas = true
          svcSummary.push(`${name}: replicas=${svc.available_replicas ?? 0} uris=[${uris.join(', ')}]`)
        }

        console.log(`  [${attempt}/${URL_POLL_MAX}] ${svcSummary.join(' | ') || 'no services yet'}`)

        // Deployment is ready when URIs are assigned and at least one replica is up.
        // This matches the platform — it marks ACTIVE when URIs exist, not when HTTP 200 arrives.
        if (hasUris && hasReplicas) {
          serviceUrls = parsed
          deploymentReady = true

          // Run probes as diagnostic info (does not affect pass/fail)
          for (const [, uris] of Object.entries(parsed)) {
            for (const uri of uris) {
              if (isLikelyTcp(uri)) {
                const parts = uri.split(':')
                const port = parseInt(parts.pop()!)
                const host = parts.join(':')
                const tcp = await probeTcp(host, port)
                console.log(`    TCP probe ${uri}: ${tcp.ok ? 'OK' : 'FAIL'} (${tcp.durationMs}ms)${tcp.error ? ' ' + tcp.error : ''}`)
              } else {
                const http = await probeHttp(uri)
                console.log(`    HTTP probe ${uri}: ${http.ok ? `OK status=${http.status}` : `status=${http.status ?? 'N/A'} ${http.error || ''}`} (${http.durationMs}ms)`)
              }
            }
          }
          break
        }
      } catch (e: any) {
        console.log(`  [${attempt}/${URL_POLL_MAX}] parse error: ${e.message}`)
      }

      if (attempt < URL_POLL_MAX) await sleep(URL_POLL_DELAY_MS)
    }

    if (deploymentReady) {
      recordStep('POLL_URLS', 'OK', Date.now() - pollStart, `Endpoints: ${JSON.stringify(serviceUrls)}`)
    } else {
      recordStep('POLL_URLS', 'FAIL', Date.now() - pollStart, 'No URIs or replicas within timeout')
    }

    // ── Step 7: Fetch container logs ──────────────────────────────
    banner('STEP 7', 'Fetch container logs')
    const logResult = await execCli('provider-services', [
      'lease-logs',
      '--dseq', String(dseq),
      '--provider', provider!,
      '--tail', '100',
    ], 45_000)
    if (logResult.exitCode === 0 && logResult.stdout.trim()) {
      const lines = logResult.stdout.trim().split('\n')
      console.log(`  Got ${lines.length} log line(s):`)
      for (const line of lines.slice(-60)) {
        console.log(`    ${line}`)
      }
      recordStep('FETCH_LOGS', 'OK', logResult.durationMs, `${lines.length} lines`)
    } else {
      console.log(`  No logs available (exit=${logResult.exitCode})`)
      if (logResult.stderr.trim()) console.log(`  stderr: ${logResult.stderr.trim().slice(0, 200)}`)
      recordStep('FETCH_LOGS', logResult.exitCode === 0 ? 'OK' : 'FAIL', logResult.durationMs, logResult.stderr.trim().slice(0, 100) || 'empty')
    }

    // ── Step 8: Final probe ──────────────────────────────────────
    if (Object.keys(serviceUrls).length > 0) {
      banner('STEP 8', 'Final endpoint probe')
      for (const [name, uris] of Object.entries(serviceUrls)) {
        for (const uri of uris) {
          if (isLikelyTcp(uri)) {
            const parts = uri.split(':')
            const port = parseInt(parts.pop()!)
            const host = parts.join(':')
            const r = await probeTcp(host, port)
            console.log(`  ${name} TCP ${uri}: ${r.ok ? 'OK' : 'FAIL'} (${r.durationMs}ms) ${r.error || ''}`)
          } else {
            const r = await probeHttp(uri)
            console.log(`  ${name} HTTP ${uri}: ${r.ok ? `OK status=${r.status}` : `FAIL ${r.error || ''}`} (${r.durationMs}ms)`)
          }
        }
      }
    }

  } finally {
    // Always close the on-chain deployment when --close is set, even on failure
    if (opts.close && dseq) {
      try {
        banner('CLEANUP', 'Close deployment')
        await doClose(dseq)
      } catch (e: any) {
        console.log(`  Close failed: ${e.message}`)
      }
    }
    try { rmSync(workDir, { recursive: true }) } catch { /* ignore */ }
  }

  // ── Final report ──────────────────────────────────────────────────
  const totalMs = Date.now() - totalStart
  console.log('\n' + '═'.repeat(70))
  console.log('  DEPLOYMENT TEST REPORT')
  console.log('═'.repeat(70))
  console.log(`  Template:   ${templateId} (${template?.name})`)
  console.log(`  Image:      ${template?.dockerImage}`)
  console.log(`  dseq:       ${dseq ?? 'N/A'}`)
  console.log(`  Owner:      ${owner ?? 'N/A'}`)
  console.log(`  Provider:   ${provider ?? 'N/A'}`)
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`)
  console.log('')
  console.log('  Step Results:')
  for (const r of stepResults) {
    const icon = r.status === 'OK' ? 'PASS' : r.status
    console.log(`    ${icon.padEnd(7)} ${r.step.padEnd(20)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${r.detail}`)
  }
  console.log('')
  const allOk = stepResults.every(r => r.status === 'OK')
  if (allOk) {
    console.log('  RESULT: ALL STEPS PASSED')
  } else {
    const failed = stepResults.filter(r => r.status !== 'OK')
    console.log(`  RESULT: ${failed.length} STEP(S) FAILED`)
    for (const f of failed) console.log(`    - ${f.step}: ${f.detail}`)
  }
  if (!opts.close && dseq) {
    console.log(`\n  Deployment is still ACTIVE on-chain. To close:`)
    console.log(`    bun scripts/test-deploy.ts close ${dseq}`)
  }
  console.log('═'.repeat(70))

  return mkResult()
}

// ── STATUS command ────────────────────────────────────────────────────

async function cmdStatus(dseq: string, providerAddr: string) {
  banner('STATUS', `Lease status for dseq=${dseq}`)
  const r = await execCli('provider-services', [
    'lease-status', '--dseq', dseq, '--provider', providerAddr,
  ], 60_000)
  logCmd(r)
  if (r.exitCode === 0) {
    try {
      const json = extractJson(r.stdout) as any
      console.log('\n  ── Parsed ──')
      console.log(indent(JSON.stringify(json, null, 2), 4))
    } catch (e: any) {
      console.log(`  Parse error: ${e.message}`)
    }
  }
}

// ── LOGS command ──────────────────────────────────────────────────────

async function cmdLogs(dseq: string, providerAddr: string, service?: string, tail = 200) {
  banner('LOGS', `Container logs for dseq=${dseq}`)
  const args = ['lease-logs', '--dseq', dseq, '--provider', providerAddr, '--tail', String(tail)]
  if (service) args.push('--service', service)
  const r = await execCli('provider-services', args, 45_000)
  logCmd(r)
}

// ── CLOSE command ─────────────────────────────────────────────────────

async function doClose(dseq: number) {
  const r = await execCli('akash', [
    'tx', 'deployment', 'close', '--dseq', String(dseq), '-o', 'json', '-y',
  ])
  logCmd(r)
  if (r.exitCode === 0) {
    console.log(`\n  Deployment ${dseq} closed on-chain.`)
    recordStep('CLOSE', 'OK', r.durationMs, `dseq=${dseq} closed`)
  } else {
    console.log(`\n  Close failed: ${r.stderr.trim().slice(0, 200)}`)
    recordStep('CLOSE', 'FAIL', r.durationMs, r.stderr.trim().slice(0, 200))
  }
}

async function cmdClose(dseq: string) {
  banner('CLOSE', `Close deployment dseq=${dseq}`)
  await doClose(parseInt(dseq, 10))
}

async function cmdCloseAll() {
  banner('CLOSE-ALL', 'List and close all active deployments for this account')
  const addrResult = await execCli('akash', ['keys', 'show', process.env.AKASH_KEY_NAME || 'default', '-a'], 15_000)
  if (addrResult.exitCode !== 0) { console.error('  Could not get wallet address'); return }
  const owner = addrResult.stdout.trim()
  console.log(`  Owner: ${owner}`)

  const listResult = await execCli('akash', ['query', 'deployment', 'list', '--owner', owner, '--state', 'active', '-o', 'json'], 30_000)
  if (listResult.exitCode !== 0) { console.error('  Could not list deployments'); return }

  try {
    const json = extractJson(listResult.stdout) as any
    const deployments = json.deployments || []
    console.log(`  Found ${deployments.length} active deployment(s)\n`)
    if (deployments.length === 0) return

    for (const d of deployments) {
      const dseq = d.deployment?.deployment_id?.dseq || d.deployment_id?.dseq
      if (!dseq) continue
      console.log(`  Closing dseq=${dseq}...`)
      await doClose(parseInt(dseq, 10))
      await sleep(3_000)
    }
    console.log(`\n  Done. Closed ${deployments.length} deployment(s).`)
  } catch (e: any) {
    console.error(`  Parse error: ${e.message}`)
  }
}

// ── PROBE command ─────────────────────────────────────────────────────

async function cmdProbe(url: string) {
  banner('PROBE', url)
  if (isLikelyTcp(url)) {
    const parts = url.split(':')
    const port = parseInt(parts.pop()!)
    const host = parts.join(':')
    console.log(`  TCP probe → ${host}:${port}`)
    const r = await probeTcp(host, port)
    console.log(`  Result: ${r.ok ? 'OK' : 'FAIL'} (${r.durationMs}ms) ${r.error || ''}`)
  } else {
    console.log(`  HTTP probe → ${url}`)
    const r = await probeHttp(url)
    console.log(`  Result: ${r.ok ? `OK status=${r.status}` : `FAIL ${r.error || ''}`} (${r.durationMs}ms)`)
  }
}

// ── LIST-TEMPLATES command ────────────────────────────────────────────

function cmdListTemplates() {
  banner('TEMPLATES', 'Available templates')
  const templates = getAllTemplates()
  console.log(`  ${templates.length} templates:\n`)
  for (const t of templates) {
    const gpu = t.resources.gpu ? ` GPU:${t.resources.gpu.units}x${t.resources.gpu.vendor}` : ''
    console.log(`  ${t.id.padEnd(25)} ${t.name.padEnd(30)} ${t.category.padEnd(12)} ${t.dockerImage}${gpu}`)
  }
}

// ── TEST-ALL command ──────────────────────────────────────────────────

async function cmdTestAll(opts: { includeGpu: boolean; preferProvider?: string }) {
  const templates = getAllTemplates()
  const toTest = opts.includeGpu
    ? templates
    : templates.filter(t => !t.resources.gpu)

  console.log('\n' + '═'.repeat(70))
  console.log('  TEST-ALL: Deploy every template, verify providers')
  console.log('═'.repeat(70))
  console.log(`  Templates total: ${templates.length}`)
  console.log(`  Testing: ${toTest.length} (${opts.includeGpu ? 'including' : 'excluding'} GPU)`)
  if (opts.preferProvider) console.log(`  Prefer provider: ${opts.preferProvider}`)
  console.log(`  Results merge into: lib/preferred-providers.json`)
  console.log('')

  const results: DeployResult[] = []
  const providerTally: Record<string, { passed: string[]; failed: string[] }> = {}

  for (let i = 0; i < toTest.length; i++) {
    const t = toTest[i]
    console.log(`\n${'━'.repeat(70)}`)
    console.log(`  [${i + 1}/${toTest.length}] Testing: ${t.id} (${t.name})`)
    console.log(`${'━'.repeat(70)}\n`)

    let result: DeployResult
    try {
      result = await cmdDeploy(t.id, {
        close: true,
        envOverrides: {},
        preferProvider: opts.preferProvider,
      })
    } catch (err: any) {
      result = {
        templateId: t.id,
        templateName: t.name,
        image: t.dockerImage,
        passed: false,
        totalMs: 0,
        steps: [],
        error: err.message || String(err),
      }
    }

    results.push(result)

    // Pause between deployments for on-chain sequence number to settle
    if (i < toTest.length - 1) await sleep(10_000)

    if (result.provider) {
      if (!providerTally[result.provider]) {
        providerTally[result.provider] = { passed: [], failed: [] }
      }
      if (result.passed) {
        providerTally[result.provider].passed.push(t.id)
      } else {
        providerTally[result.provider].failed.push(t.id)
      }
    }

    console.log(`\n  >> ${t.id}: ${result.passed ? 'PASSED' : 'FAILED'}${result.provider ? ` on ${result.provider}` : ''}`)
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(70))
  console.log('  TEST-ALL SUMMARY')
  console.log('═'.repeat(70))

  const passed = results.filter(r => r.passed)
  const failed = results.filter(r => !r.passed)

  console.log(`\n  Passed: ${passed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log(`  Failed:`)
    for (const f of failed) {
      const failSteps = f.steps.filter(s => s.status !== 'OK')
      const reason = failSteps.length > 0
        ? failSteps.map(s => `${s.step}: ${s.detail}`).join('; ')
        : (f.error || 'unknown')
      console.log(`    - ${f.templateId}: ${reason.slice(0, 120)}`)
    }
  }

  console.log('\n  Provider results:')
  for (const [addr, tally] of Object.entries(providerTally)) {
    console.log(`    ${addr}`)
    console.log(`      passed: ${tally.passed.length} (${tally.passed.join(', ')})`)
    if (tally.failed.length > 0) {
      console.log(`      failed: ${tally.failed.length} (${tally.failed.join(', ')})`)
    }
  }

  // ── Merge into preferred-providers.json ─────────────────────────────
  // Reads existing file, adds/updates providers that passed ALL their
  // deployments this run, preserves existing entries from prior runs.

  const libDir = resolve(import.meta.dir, '../lib')
  if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true })
  const outPath = resolve(libDir, 'preferred-providers.json')

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
    _run: string
    generatedAt: string
    providers: PreferredEntry[]
  }

  const RUN_CMD = 'cd service-cloud-api && bun scripts/test-deploy.ts test-all'
  let existing: PreferredFile = { _run: RUN_CMD, generatedAt: '', providers: [] }
  try {
    const raw = readFileSync(outPath, 'utf-8')
    existing = JSON.parse(raw) as PreferredFile
  } catch { /* first run, start empty */ }

  const existingByAddr = new Map(existing.providers.map(p => [p.address, p]))

  // Determine which providers from this run qualify as verified
  const MIN_PASS_RATE = 0.5
  const now = new Date().toISOString()

  for (const [addr, tally] of Object.entries(providerTally)) {
    const total = tally.passed.length + tally.failed.length
    const passRate = tally.passed.length / total

    if (tally.passed.length === 0) continue

    if (passRate >= MIN_PASS_RATE) {
      const entry: PreferredEntry = {
        address: addr,
        name: existingByAddr.get(addr)?.name ?? `Provider ${addr.slice(5, 9)}`,
        verified: true,
        testedAt: now,
        templatesPassed: tally.passed.length,
        templatesTested: total,
        notes: `Passed: ${tally.passed.join(', ')}` +
          (tally.failed.length > 0 ? `. Failed: ${tally.failed.join(', ')}` : ''),
      }
      existingByAddr.set(addr, entry)
      console.log(`\n  ✓ ${addr}: ADDED/UPDATED (${tally.passed.length}/${total} passed)`)
    } else {
      // Provider failed too many — remove from verified if it was there
      if (existingByAddr.has(addr)) {
        existingByAddr.delete(addr)
        console.log(`\n  ✗ ${addr}: REMOVED (${tally.passed.length}/${total} passed, below ${MIN_PASS_RATE * 100}% threshold)`)
      }
    }
  }

  const outFile: PreferredFile = {
    _run: RUN_CMD,
    generatedAt: now,
    providers: Array.from(existingByAddr.values()),
  }

  writeFileSync(outPath, JSON.stringify(outFile, null, 2) + '\n')
  console.log(`\n  Results merged into: ${outPath}`)
  console.log(`  Total verified providers: ${outFile.providers.length}`)

  for (const p of outFile.providers) {
    console.log(`    ${p.verified ? '●' : '○'} ${p.address} (${p.name}) — ${p.templatesPassed} passed`)
  }

  console.log('═'.repeat(70))
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    console.log(`
  AF Deployment Test Tool

  Usage:
    bun scripts/test-deploy.ts deploy <template-id> [--close] [--provider <addr>] [--env KEY=VAL ...]
    bun scripts/test-deploy.ts test-all [--no-gpu] [--provider <addr>]
    bun scripts/test-deploy.ts status <dseq> --provider <addr>
    bun scripts/test-deploy.ts logs   <dseq> --provider <addr> [--service name] [--tail N]
    bun scripts/test-deploy.ts close  <dseq>
    bun scripts/test-deploy.ts close-all
    bun scripts/test-deploy.ts probe  <url>
    bun scripts/test-deploy.ts list-templates

  test-all:
    Deploys every template sequentially, records pricing, and writes
    service-cloud-api/lib/preferred-providers.json when a single provider
    passes all templates. GPU templates are included by default.
    Use --no-gpu to skip GPU templates. Use --provider to force
    a specific provider for all deployments.
    `)
    process.exit(0)
  }

  switch (command) {
    case 'deploy': {
      const templateId = args[1]
      if (!templateId) { console.error('Usage: deploy <template-id>'); process.exit(1) }
      const close = args.includes('--close')
      const provIdx = args.indexOf('--provider')
      const preferProvider = provIdx >= 0 ? args[provIdx + 1] : undefined
      const envOverrides: Record<string, string> = {}
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--env' && args[i + 1]) {
          const [k, ...vParts] = args[i + 1].split('=')
          envOverrides[k] = vParts.join('=')
          i++
        }
      }
      await cmdDeploy(templateId, { close, envOverrides, preferProvider })
      break
    }
    case 'status': {
      const dseq = args[1]
      const provIdx = args.indexOf('--provider')
      const prov = provIdx >= 0 ? args[provIdx + 1] : undefined
      if (!dseq || !prov) { console.error('Usage: status <dseq> --provider <addr>'); process.exit(1) }
      await cmdStatus(dseq, prov)
      break
    }
    case 'logs': {
      const dseq = args[1]
      const provIdx = args.indexOf('--provider')
      const prov = provIdx >= 0 ? args[provIdx + 1] : undefined
      const svcIdx = args.indexOf('--service')
      const svc = svcIdx >= 0 ? args[svcIdx + 1] : undefined
      const tailIdx = args.indexOf('--tail')
      const tail = tailIdx >= 0 ? parseInt(args[tailIdx + 1]) : 200
      if (!dseq || !prov) { console.error('Usage: logs <dseq> --provider <addr>'); process.exit(1) }
      await cmdLogs(dseq, prov, svc, tail)
      break
    }
    case 'close': {
      const dseq = args[1]
      if (!dseq) { console.error('Usage: close <dseq>'); process.exit(1) }
      await cmdClose(dseq)
      break
    }
    case 'close-all': {
      await cmdCloseAll()
      break
    }
    case 'probe': {
      const url = args[1]
      if (!url) { console.error('Usage: probe <url>'); process.exit(1) }
      await cmdProbe(url)
      break
    }
    case 'test-all': {
      const excludeGpu = args.includes('--no-gpu')
      const provIdx = args.indexOf('--provider')
      const preferProvider = provIdx >= 0 ? args[provIdx + 1] : undefined
      await cmdTestAll({ includeGpu: !excludeGpu, preferProvider })
      break
    }
    case 'list-templates':
      cmdListTemplates()
      break
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
