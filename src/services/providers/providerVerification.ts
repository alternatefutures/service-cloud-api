/**
 * Provider Verification Module
 *
 * Runs end-to-end Akash deployment tests against all templates to verify
 * which providers reliably bid and serve workloads. Called by
 * ProviderVerificationScheduler (daily cron in production) and by the
 * local test-deploy.ts CLI script.
 *
 * Each template goes through: generate SDL → submit tx → poll bids →
 * create lease → send manifest → poll lease status → probe endpoints → close.
 */

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PrismaClient, ComputeProviderType } from '@prisma/client'
import { getAkashEnv as getAkashEnvBase } from '../../lib/akashEnv.js'
import { getAllTemplates } from '../../templates/registry.js'
import { DEFAULT_DEPOSIT_UACT } from '../akash/orchestrator.js'
import { withWalletLock } from '../akash/walletMutex.js'
import { generateSDLFromTemplate } from '../../templates/sdl.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('provider-verification')

// ── Constants ──────────────────────────────────────────────────────────

const BID_POLL_MAX = 12
const BID_POLL_DELAY_BASE_MS = 5_000
const URL_POLL_MAX = 24
const URL_POLL_DELAY_MS = 5_000
const CLI_TIMEOUT_MS = 120_000
const MIN_PASS_RATE = 1.0
const MIN_ACT_BALANCE_UACT = 5_000_000
const INTER_TEMPLATE_DELAY_MS = 10_000
const INTER_BIDDER_DELAY_MS = 8_000

// ── Types ──────────────────────────────────────────────────────────────

export interface VerificationOptions {
  includeGpu?: boolean
  cheapestOnly?: boolean
}

interface BidderInfo {
  provider: string
  amount: string
  denom: string
}

export interface TemplateTestResult {
  templateId: string
  templateName: string
  image: string
  passed: boolean
  dseq?: number
  owner?: string
  provider?: string
  priceUact?: string
  totalMs: number
  error?: string
  allBidders?: BidderInfo[]
}

export interface VerificationSummary {
  templatesTotal: number
  templatesPassed: number
  deployments: number
  passed: number
  failed: number
  uniqueProviders: number
  results: TemplateTestResult[]
  providerTally: Record<string, { passed: string[]; failed: string[]; prices: string[] }>
  runId: string
  costUakt: bigint
  costUact: bigint
}

export interface WalletBalance {
  akt: number
  act: number
  uakt: number
  uact: number
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

// ── Helpers ────────────────────────────────────────────────────────────

function getAkashEnv() { return getAkashEnvBase({ broadcastMode: 'block' }) }

function execCli(bin: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<ExecResult> {
  const env = getAkashEnv()
  const start = Date.now()
  return new Promise(res => {
    execFile(bin, args, { encoding: 'utf-8', env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - start
      const exitCode = err ? (err as any).code ?? 1 : 0
      res({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, durationMs })
    })
  })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try { return JSON.parse(trimmed) } catch { /* continue */ }
  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
  if (startIdx === -1) throw new SyntaxError(`No JSON in output: ${trimmed.slice(0, 200)}`)
  return JSON.parse(trimmed.slice(startIdx))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function probeHttp(uri: string): Promise<{ ok: boolean; status?: number; durationMs: number; error?: string }> {
  const candidates = uri.startsWith('http://') || uri.startsWith('https://') ? [uri] : [`https://${uri}`, `http://${uri}`]
  for (const url of candidates) {
    const start = Date.now()
    try {
      const resp = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) })
      return { ok: resp.status < 500, status: resp.status, durationMs: Date.now() - start }
    } catch (e: any) {
      if (url === candidates[candidates.length - 1]) {
        return { ok: false, durationMs: Date.now() - start, error: e.message?.slice(0, 200) }
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
    sock.on('error', (e: any) => { sock.destroy(); res({ ok: false, durationMs: Date.now() - start, error: e.message }) })
    sock.on('timeout', () => { sock.destroy(); res({ ok: false, durationMs: Date.now() - start, error: 'timeout' }) })
  })
}

function isLikelyTcp(uri: string): boolean {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return false
  const parts = uri.split(':')
  if (parts.length < 2) return false
  const port = Number(parts.at(-1))
  return !Number.isNaN(port) && port !== 80 && port !== 443
}

// ── Balance check ──────────────────────────────────────────────────────

export async function checkBalance(): Promise<WalletBalance> {
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  const addrResult = await execCli('akash', ['keys', 'show', keyName, '-a'], 15_000)
  if (addrResult.exitCode !== 0) throw new Error(`Cannot get wallet address: ${addrResult.stderr.trim()}`)

  const owner = addrResult.stdout.trim()
  const balResult = await execCli('akash', ['query', 'bank', 'balances', owner, '-o', 'json'], 15_000)
  if (balResult.exitCode !== 0) throw new Error(`Cannot query balance: ${balResult.stderr.trim()}`)

  const balJson = extractJson(balResult.stdout) as any
  const balances = balJson.balances || []
  const uaktEntry = balances.find((b: any) => b.denom === 'uakt')
  const uactEntry = balances.find((b: any) => b.denom === 'uact')
  const uakt = parseInt(uaktEntry?.amount || '0', 10)
  const uact = parseInt(uactEntry?.amount || '0', 10)
  return { akt: uakt / 1_000_000, act: uact / 1_000_000, uakt, uact }
}

// ── Single template test ───────────────────────────────────────────────

async function testSingleTemplate(
  templateId: string,
  preferProvider?: string
): Promise<TemplateTestResult> {
  const totalStart = Date.now()
  const template = getAllTemplates().find(t => t.id === templateId)
  if (!template) {
    return { templateId, templateName: templateId, image: 'unknown', passed: false, totalMs: 0, error: `Template not found: ${templateId}` }
  }

  const mkFail = (error: string): TemplateTestResult => ({
    templateId, templateName: template.name, image: template.dockerImage,
    passed: false, totalMs: Date.now() - totalStart, error,
  })

  if (!process.env.AKASH_MNEMONIC) return mkFail('AKASH_MNEMONIC not set')

  // Generate SDL
  const autoEnv: Record<string, string> = {}
  for (const v of template.envVars) {
    if (v.default === null && v.required) {
      autoEnv[v.key] = randomBytes(16).toString('base64url')
    }
  }

  const sdl = generateSDLFromTemplate(template, {
    serviceName: `test-${templateId}`,
    envOverrides: autoEnv,
  })

  const workDir = mkdtempSync(join(tmpdir(), 'af-verify-'))
  const sdlPath = join(workDir, 'deploy.yaml')
  writeFileSync(sdlPath, sdl)

  let dseq: number | undefined
  let owner: string | undefined
  let provider: string | undefined
  let priceAmount: string | undefined
  let allBidders: BidderInfo[] = []

  try {
    // Step 1: Get wallet address
    const addrResult = await execCli('akash', ['keys', 'show', process.env.AKASH_KEY_NAME || 'default', '-a'], 15_000)
    if (addrResult.exitCode !== 0) return mkFail(`Cannot get address: ${addrResult.stderr.trim()}`)
    owner = addrResult.stdout.trim()

    // Step 2: Submit deployment tx (with sequence mismatch retry).
    // Serialized on the shared wallet mutex so the verifier doesn't race
    // the billing scheduler / health monitor / deployment workers.
    const TX_RETRIES = 3
    let txJson: any = {}
    for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
      const txResult = await withWalletLock(() =>
        execCli('akash', [
          'tx', 'deployment', 'create', sdlPath,
          '--deposit', `${DEFAULT_DEPOSIT_UACT}uact`, '-o', 'json', '-y',
        ])
      )
      if (txResult.exitCode !== 0) return mkFail(txResult.stderr.trim().slice(0, 300))
      try { txJson = extractJson(txResult.stdout) as any } catch { txJson = {} }
      const code = typeof txJson.code === 'number' ? txJson.code : parseInt(txJson.code ?? '0', 10)
      if (code === 32 && attempt < TX_RETRIES) { await sleep(8_000); continue }
      if (code !== 0) return mkFail(`tx rejected (code ${code}): ${(txJson.raw_log || '').slice(0, 200)}`)
      break
    }

    // Extract dseq
    const logs = txJson.logs as any[] | undefined
    if (logs) {
      for (const l of logs) {
        for (const event of l.events || []) {
          const attr = event.attributes?.find((a: any) => a.key === 'dseq')
          if (attr) { dseq = parseInt(attr.value, 10); break }
        }
        if (dseq) break
      }
    }
    if (!dseq && txJson.txhash) {
      log.info({ txhash: txJson.txhash, templateId }, 'Polling for tx confirmation')
      for (const delay of [8000, 6000, 6000, 8000, 8000]) {
        await sleep(delay)
        const qr = await execCli('akash', ['query', 'tx', txJson.txhash, '-o', 'json'], 60_000)
        if (qr.exitCode !== 0) continue
        try {
          const qj = extractJson(qr.stdout) as any
          const qLogs = qj.logs as any[] | undefined
          if (qLogs) {
            for (const l of qLogs) {
              for (const event of l.events || []) {
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
          if (dseq) break
        } catch { /* retry */ }
      }
    }
    if (!dseq || isNaN(dseq) || dseq <= 0) return mkFail('Could not extract dseq from tx')

    log.info({ dseq, templateId }, 'Deployment created on-chain')

    // Step 3: Poll for bids
    let selectedBid: any = null
    for (let attempt = 1; attempt <= BID_POLL_MAX; attempt++) {
      const delay = attempt === 1 ? 10_000 : BID_POLL_DELAY_BASE_MS * attempt
      await sleep(delay)
      const bidResult = await execCli('akash', [
        'query', 'market', 'bid', 'list', '--owner', owner, '--dseq', String(dseq), '-o', 'json',
      ])
      if (bidResult.exitCode !== 0) continue

      try {
        const bidJson = extractJson(bidResult.stdout) as any
        const rawBids = bidJson.bids || []
        if (rawBids.length === 0) continue

        const openBids = rawBids
          .map((b: any) => {
            const bid = b.bid || b; const id = bid.bid_id || bid.id || {}; const price = bid.price || {}
            return { provider: String(id.provider || ''), gseq: Number(id.gseq || 1), oseq: Number(id.oseq || 1), amount: String(price.amount || '0'), denom: String(price.denom || 'uakt'), state: bid.state }
          })
          .filter((b: any) => b.state === 'open')
          .sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))

        if (openBids.length > 0) {
          allBidders = openBids.map((b: any) => ({ provider: b.provider, amount: b.amount, denom: b.denom }))
          if (preferProvider) {
            selectedBid = openBids.find((b: any) => b.provider.startsWith(preferProvider)) || openBids[0]
          } else {
            selectedBid = openBids[0]
          }
          break
        }
      } catch { /* retry */ }
    }

    if (!selectedBid) return mkFail('No bids received within timeout')

    provider = selectedBid.provider
    priceAmount = selectedBid.amount
    log.info({ dseq, provider, price: priceAmount, templateId }, 'Bid selected')

    // Step 4: Create lease (with sequence mismatch retry)
    let leaseOk = false
    for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
      const leaseResult = await withWalletLock(() =>
        execCli('akash', [
          'tx', 'market', 'lease', 'create',
          '--dseq', String(dseq), '--gseq', String(selectedBid.gseq), '--oseq', String(selectedBid.oseq),
          '--provider', provider!, '-o', 'json', '-y',
        ])
      )
      if (leaseResult.exitCode !== 0) return mkFail(`Lease creation failed: ${leaseResult.stderr.trim().slice(0, 200)}`)
      let leaseCode = 0
      try { leaseCode = (extractJson(leaseResult.stdout) as any)?.code ?? 0 } catch { /* ok */ }
      if (leaseCode === 32 && attempt < TX_RETRIES) { await sleep(8_000); continue }
      if (leaseCode !== 0) return mkFail(`Lease tx rejected (code ${leaseCode})`)
      await sleep(10_000)
      leaseOk = true
      break
    }
    if (!leaseOk) return mkFail('Lease creation failed after retries')

    // Step 5: Send manifest (with retries)
    let manifestOk = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const mResult = await execCli('provider-services', [
        'send-manifest', sdlPath, '--dseq', String(dseq), '--provider', provider!,
      ])
      if (mResult.exitCode === 0 && !mResult.stderr.toLowerCase().includes('error')) {
        manifestOk = true
        break
      }
      if (attempt < 3) await sleep(attempt * 5000)
    }
    if (!manifestOk) return mkFail('Manifest send failed after retries')

    // Step 6: Poll lease status for endpoints
    await sleep(10_000)
    let deploymentReady = false
    for (let attempt = 1; attempt <= URL_POLL_MAX; attempt++) {
      const lsResult = await execCli('provider-services', [
        'lease-status', '--dseq', String(dseq), '--provider', provider!,
      ], 60_000)
      if (lsResult.exitCode !== 0) { if (attempt < URL_POLL_MAX) { await sleep(URL_POLL_DELAY_MS); continue } break }

      try {
        const lsJson = extractJson(lsResult.stdout) as any
        const services = lsJson.services || {}
        const forwardedPorts = lsJson.forwarded_ports || {}
        let hasUris = false
        let hasReplicas = false

        for (const [name, svc] of Object.entries<any>(services)) {
          const uris: string[] = [...(svc.uris || [])]
          if (uris.length === 0 && forwardedPorts[name]?.length) {
            for (const fp of forwardedPorts[name]) uris.push(`${fp.host}:${fp.externalPort}`)
          }
          if (uris.length > 0) hasUris = true
          if ((svc.available_replicas ?? 0) > 0) hasReplicas = true
        }

        if (hasUris && hasReplicas) {
          deploymentReady = true
          // Run diagnostic probes (informational only)
          for (const [, svc] of Object.entries<any>(services)) {
            for (const uri of (svc.uris || [])) {
              if (isLikelyTcp(uri)) {
                const parts = uri.split(':'); const port = parseInt(parts.pop()!); const host = parts.join(':')
                await probeTcp(host, port)
              } else {
                await probeHttp(uri)
              }
            }
          }
          break
        }
      } catch { /* retry */ }

      if (attempt < URL_POLL_MAX) await sleep(URL_POLL_DELAY_MS)
    }

    if (!deploymentReady) return mkFail('No URIs or replicas within timeout')

    log.info({ dseq, templateId, provider, totalMs: Date.now() - totalStart }, 'Template test PASSED')

    return {
      templateId, templateName: template.name, image: template.dockerImage,
      passed: true, dseq, owner, provider, priceUact: priceAmount,
      totalMs: Date.now() - totalStart, allBidders,
    }
  } catch (err: any) {
    return mkFail(err.message || String(err))
  } finally {
    if (dseq) {
      try {
        await withWalletLock(() =>
          execCli('akash', ['tx', 'deployment', 'close', '--dseq', String(dseq), '-o', 'json', '-y'])
        )
        log.info({ dseq, templateId }, 'Test deployment closed')
      } catch { /* best-effort */ }
    }
    try { rmSync(workDir, { recursive: true }) } catch { /* ignore */ }
  }
}

// ── Full verification suite ────────────────────────────────────────────

export async function runVerificationSuite(
  prisma: PrismaClient,
  options: VerificationOptions = {},
): Promise<VerificationSummary> {
  const { includeGpu = true, cheapestOnly = false } = options

  const templates = getAllTemplates()
  const production = templates.filter(t => !t.releaseStage || t.releaseStage === 'production')
  const toTest = includeGpu ? production : production.filter(t => !t.resources.gpu)

  log.info({ total: templates.length, testing: toTest.length, includeGpu, cheapestOnly }, 'Starting verification suite')

  // Snapshot wallet balance before the run
  let balanceBefore: WalletBalance | null = null
  try { balanceBefore = await checkBalance() } catch { /* non-fatal */ }

  // Create a VerificationRun record to track this run
  const run = await prisma.verificationRun.create({
    data: {
      startedAt: new Date(),
      templatesTotal: toTest.length,
      templatesPassed: 0,
      status: 'running',
    },
  })
  log.info({ runId: run.id }, 'VerificationRun record created')

  const results: TemplateTestResult[] = []
  const providerTally: Record<string, { passed: string[]; failed: string[]; prices: string[] }> = {}

  const recordResult = (result: TemplateTestResult) => {
    results.push(result)
    if (result.provider) {
      if (!providerTally[result.provider]) providerTally[result.provider] = { passed: [], failed: [], prices: [] }
      if (result.passed) providerTally[result.provider].passed.push(result.templateId)
      else providerTally[result.provider].failed.push(result.templateId)
      if (result.priceUact) providerTally[result.provider].prices.push(result.priceUact)
    }
  }

  let runError: string | undefined
  // Tracked outside the loop so the `finally` finaliser can write
  // partial-progress numbers even if persistResults / checkBalance /
  // anything else throws after the loop completes.
  let costUakt = BigInt(0)
  let costUact = BigInt(0)
  let templatesPassed = 0

  try {
    try {
      for (let i = 0; i < toTest.length; i++) {
        const t = toTest[i]
        log.info({ index: i + 1, total: toTest.length, templateId: t.id }, 'Testing template')

        const result = await testSingleTemplate(t.id)
        recordResult(result)
        log.info({ templateId: t.id, passed: result.passed, provider: result.provider }, 'Template result')

        if (!cheapestOnly && result.allBidders && result.allBidders.length > 1) {
          const testedProviders = new Set<string>()
          if (result.provider) testedProviders.add(result.provider)

          for (const bidder of result.allBidders.filter(b => !testedProviders.has(b.provider))) {
            await sleep(INTER_BIDDER_DELAY_MS)
            log.info({ templateId: t.id, provider: bidder.provider }, 'Re-testing with additional bidder')

            const bidderResult = await testSingleTemplate(t.id, bidder.provider)
            recordResult(bidderResult)
            if (bidderResult.provider) testedProviders.add(bidderResult.provider)

            log.info({ templateId: t.id, passed: bidderResult.passed, provider: bidderResult.provider }, 'Bidder result')
          }
        }

        if (i < toTest.length - 1) await sleep(INTER_TEMPLATE_DELAY_MS)
      }
    } catch (err: any) {
      runError = err.message || String(err)
    }

    // Persist provider/template results — wrapped because a DB hiccup
    // here used to leave the run row stranded in 'running' forever.
    try {
      await persistResults(prisma, results, providerTally)
    } catch (err: any) {
      runError = runError ?? `persistResults failed: ${err.message || String(err)}`
    }

    const templateResultMap = new Map<string, { passedProviders: string[] }>()
    for (const r of results) {
      if (!templateResultMap.has(r.templateId)) templateResultMap.set(r.templateId, { passedProviders: [] })
      if (r.passed && r.provider) templateResultMap.get(r.templateId)!.passedProviders.push(r.provider)
    }
    templatesPassed = Array.from(templateResultMap.values()).filter(v => v.passedProviders.length > 0).length

    // Snapshot wallet balance after the run and compute cost delta
    try {
      const balanceAfter = await checkBalance()
      if (balanceBefore) {
        costUakt = BigInt(Math.max(0, balanceBefore.uakt - balanceAfter.uakt))
        costUact = BigInt(Math.max(0, balanceBefore.uact - balanceAfter.uact))
        log.info({ costUakt: costUakt.toString(), costUact: costUact.toString() }, 'Run cost computed from balance delta')
      }
    } catch { /* non-fatal */ }
  } finally {
    // Finalize the VerificationRun record. ALWAYS runs — even if the
    // loop or persistResults threw — so the dashboard never sees a
    // stranded `running` row from an in-process failure. (Out-of-
    // process kills are still cleaned up by markStaleVerifierRuns at
    // the next scheduler startup.)
    const passedCount = results.filter(r => r.passed).length
    const failedCount = results.filter(r => !r.passed).length
    try {
      await prisma.verificationRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          templatesPassed,
          deployments: results.length,
          passed: passedCount,
          failed: failedCount,
          uniqueProviders: Object.keys(providerTally).length,
          costUakt,
          costUact,
          status: runError ? 'failed' : 'completed',
          error: runError?.slice(0, 1000) || null,
        },
      })
    } catch (err) {
      log.error(
        { runId: run.id, err: err instanceof Error ? err.message : err },
        'Could not finalise VerificationRun row — startup recovery will sweep it',
      )
    }
  }

  const summary: VerificationSummary = {
    templatesTotal: toTest.length,
    templatesPassed,
    deployments: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    uniqueProviders: Object.keys(providerTally).length,
    results,
    providerTally,
    runId: run.id,
    costUakt,
    costUact,
  }

  log.info({
    runId: run.id,
    templatesTotal: summary.templatesTotal,
    templatesPassed: summary.templatesPassed,
    deployments: summary.deployments,
    passed: summary.passed,
    failed: summary.failed,
    uniqueProviders: summary.uniqueProviders,
    costUakt: costUakt.toString(),
    costUact: costUact.toString(),
  }, 'Verification suite complete')

  return summary
}

// ── Result persistence ─────────────────────────────────────────────────

async function persistResults(
  prisma: PrismaClient,
  results: TemplateTestResult[],
  providerTally: Record<string, { passed: string[]; failed: string[]; prices: string[] }>,
): Promise<void> {
  const now = new Date()

  for (const [addr, tally] of Object.entries(providerTally)) {
    const total = tally.passed.length + tally.failed.length
    const passRate = tally.passed.length / total
    const verified = passRate >= MIN_PASS_RATE && tally.passed.length > 0

    let minPrice: bigint | undefined
    let maxPrice: bigint | undefined
    for (const p of tally.prices) {
      const val = BigInt(p.split('.')[0])
      if (minPrice === undefined || val < minPrice) minPrice = val
      if (maxPrice === undefined || val > maxPrice) maxPrice = val
    }

    await prisma.computeProvider.upsert({
      where: { address: addr },
      create: {
        address: addr,
        providerType: 'AKASH' as ComputeProviderType,
        name: `Provider ${addr.slice(5, 9)}`,
        verified,
        lastTestedAt: now,
        ...(minPrice !== undefined ? { minPriceUact: minPrice } : {}),
        ...(maxPrice !== undefined ? { maxPriceUact: maxPrice } : {}),
      },
      update: {
        verified,
        lastTestedAt: now,
        ...(minPrice !== undefined ? { minPriceUact: minPrice } : {}),
        ...(maxPrice !== undefined ? { maxPriceUact: maxPrice } : {}),
      },
    })

    log.info({ address: addr, verified, passed: tally.passed.length, total }, 'Provider result persisted')
  }

  for (const result of results) {
    if (!result.provider) continue
    const provider = await prisma.computeProvider.findUnique({ where: { address: result.provider }, select: { id: true } })
    if (!provider) continue

    const priceVal = result.priceUact ? BigInt(result.priceUact.split('.')[0]) : null

    await prisma.providerTemplateResult.upsert({
      where: { providerId_templateId: { providerId: provider.id, templateId: result.templateId } },
      create: {
        providerId: provider.id,
        templateId: result.templateId,
        passed: result.passed,
        priceUact: priceVal,
        durationMs: result.totalMs,
        errorMessage: result.passed ? null : (result.error?.slice(0, 500) || null),
        testedAt: now,
      },
      update: {
        passed: result.passed,
        priceUact: priceVal,
        durationMs: result.totalMs,
        errorMessage: result.passed ? null : (result.error?.slice(0, 500) || null),
        testedAt: now,
      },
    })
  }

  const verifiedCount = await prisma.computeProvider.count({ where: { verified: true } })
  log.info({ verifiedCount }, 'Results persisted to database')
}

// ── Staging sync ───────────────────────────────────────────────────────

export async function syncToStaging(prisma: PrismaClient): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    log.warn('DATABASE_URL not set, cannot derive staging URL — skipping staging sync')
    return
  }

  // Derive staging URL by replacing the database name
  const stagingUrl = databaseUrl.replace(/\/alternatefutures(\?|$)/, '/alternatefutures_staging$1')
  if (stagingUrl === databaseUrl) {
    log.warn('Could not derive staging database URL — skipping staging sync')
    return
  }

  const { PrismaClient: PrismaClientClass } = await import('@prisma/client')
  const stagingPrisma = new PrismaClientClass({ datasources: { db: { url: stagingUrl } } })

  try {
    // Read tested/GPU/verified providers from production
    const providers = await prisma.computeProvider.findMany({
      where: { OR: [{ lastTestedAt: { not: null } }, { gpuTotal: { gt: 0 } }, { verified: true }] },
      orderBy: { address: 'asc' },
    })

    const templateResults = await prisma.providerTemplateResult.findMany({
      include: { provider: { select: { address: true } } },
    })

    log.info({ providers: providers.length, templateResults: templateResults.length }, 'Syncing to staging')

    for (const p of providers) {
      await stagingPrisma.computeProvider.upsert({
        where: { address: p.address },
        create: {
          address: p.address,
          providerType: p.providerType,
          name: p.name,
          verified: p.verified,
          blocked: p.blocked,
          blockReason: p.blockReason,
          isOnline: p.isOnline,
          lastSeenOnlineAt: p.lastSeenOnlineAt,
          gpuModels: p.gpuModels,
          gpuAvailable: p.gpuAvailable,
          gpuTotal: p.gpuTotal,
          minPriceUact: p.minPriceUact,
          maxPriceUact: p.maxPriceUact,
          attributes: p.attributes as any,
          lastTestedAt: p.lastTestedAt,
        },
        update: {
          verified: p.verified,
          blocked: p.blocked,
          blockReason: p.blockReason,
          isOnline: p.isOnline,
          lastSeenOnlineAt: p.lastSeenOnlineAt,
          gpuModels: p.gpuModels,
          gpuAvailable: p.gpuAvailable,
          gpuTotal: p.gpuTotal,
          minPriceUact: p.minPriceUact,
          maxPriceUact: p.maxPriceUact,
          attributes: p.attributes as any,
          lastTestedAt: p.lastTestedAt,
        },
      })
    }

    for (const tr of templateResults) {
      const stagingProvider = await stagingPrisma.computeProvider.findUnique({
        where: { address: tr.provider.address },
        select: { id: true },
      })
      if (!stagingProvider) continue

      await stagingPrisma.providerTemplateResult.upsert({
        where: { providerId_templateId: { providerId: stagingProvider.id, templateId: tr.templateId } },
        create: {
          providerId: stagingProvider.id,
          templateId: tr.templateId,
          passed: tr.passed,
          priceUact: tr.priceUact,
          durationMs: tr.durationMs,
          errorMessage: tr.errorMessage,
          testedAt: tr.testedAt,
        },
        update: {
          passed: tr.passed,
          priceUact: tr.priceUact,
          durationMs: tr.durationMs,
          errorMessage: tr.errorMessage,
          testedAt: tr.testedAt,
        },
      })
    }

    log.info('Staging sync complete')
  } finally {
    await stagingPrisma.$disconnect()
  }
}
