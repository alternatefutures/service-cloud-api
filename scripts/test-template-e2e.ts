#!/usr/bin/env bun
/**
 * End-to-end template deployment test via the GraphQL API.
 *
 * Unlike test-deploy.ts (which uses raw Akash CLI), this script tests the
 * FULL platform stack: GraphQL mutation → template system → provider dispatch
 * → on-chain deployment → container health monitoring → endpoint probing.
 *
 * Supports both simple (single-service) and composite (multi-service) templates.
 *
 * Usage:
 *   bun scripts/test-template-e2e.ts deploy <template-id> [options]
 *   bun scripts/test-template-e2e.ts test-all [options]
 *   bun scripts/test-template-e2e.ts health <service-id>
 *   bun scripts/test-template-e2e.ts list
 *
 * Options:
 *   --project-id <id>     Use existing project (default: creates temp project)
 *   --provider <name>     Provider: 'akash' (default) or 'phala'
 *   --close               Close deployment after test
 *   --env KEY=VAL         Override env vars (repeatable)
 *   --api-url <url>       GraphQL API URL (default: https://api.alternatefutures.ai)
 *   --timeout <seconds>   Health poll timeout (default: 300)
 *   --no-gpu              Skip GPU templates in test-all
 *
 * Auth:
 *   Set AF_TEST_TOKEN env var to a valid JWT access token.
 *   Or set AF_TEST_EMAIL + AF_TEST_PASSWORD for auto-login.
 *   Or provide --token <jwt> on the command line.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// ── Load env ─────────────────────────────────────────────────────────

function loadEnvFile(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx)
    let val = trimmed.slice(eqIdx + 1)
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

loadEnvFile(resolve(import.meta.dir, '../../admin/cloud/secrets/.env.local'))
loadEnvFile(resolve(import.meta.dir, '../.env'))

import { getTemplateById, getAllTemplates } from '../src/templates/registry.js'

// ── Types ────────────────────────────────────────────────────────────

interface ContainerHealth {
  name: string
  status: string
  ready: boolean
  total: number
  available: number
  uris: string[]
  message?: string
}

interface DeploymentHealth {
  provider: string
  overall: string
  containers: ContainerHealth[]
  lastChecked: string
}

type StepStatus = 'OK' | 'FAIL' | 'TIMEOUT' | 'SKIP'

interface StepResult {
  step: string
  status: StepStatus
  durationMs: number
  detail: string
}

interface TestResult {
  templateId: string
  templateName: string
  composite: boolean
  provider: string
  passed: boolean
  serviceId?: string
  totalMs: number
  steps: StepResult[]
  health?: DeploymentHealth
  endpoints?: Record<string, string[]>
  error?: string
}

// ── GraphQL Queries / Mutations ──────────────────────────────────────

const GQL_CREATE_PROJECT = `
  mutation CreateProject($data: CreateProjectDataInput!) {
    createProject(data: $data) { id name }
  }
`

const GQL_DELETE_PROJECT = `
  mutation DeleteProject($id: ID!) { deleteProject(id: $id) }
`

const GQL_DEPLOY_SIMPLE = `
  mutation DeployFromTemplate($input: DeployFromTemplateInput!) {
    deployFromTemplate(input: $input) {
      id dseq status serviceUrls errorMessage
    }
  }
`

const GQL_DEPLOY_COMPOSITE = `
  mutation DeployCompositeTemplate($input: DeployCompositeTemplateInput!) {
    deployCompositeTemplate(input: $input) { primaryServiceId }
  }
`

const GQL_DEPLOYMENT_HEALTH = `
  query DeploymentHealth($serviceId: ID!) {
    deploymentHealth(serviceId: $serviceId) {
      provider overall
      containers { name status ready total available uris message }
      lastChecked
    }
  }
`

const GQL_SERVICE_REGISTRY = `
  query GetServiceRegistry {
    serviceRegistry {
      id name status templateId parentServiceId sdlServiceName
      akashDeployments { id dseq status serviceUrls errorMessage }
      phalaDeployments { id status appUrl errorMessage }
    }
  }
`

const GQL_CLOSE_AKASH = `
  mutation CloseAkashDeployment($id: ID!) {
    closeAkashDeployment(id: $id) { id status }
  }
`

// ── GraphQL client ───────────────────────────────────────────────────

let API_URL = 'https://api.alternatefutures.ai'
let AUTH_TOKEN = ''

async function gql<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }

  return res.json()
}

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n)
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

function banner(step: string, description: string) {
  const line = '═'.repeat(70)
  console.log(`\n${line}`)
  console.log(`  ${step}: ${description}`)
  console.log(line)
}

async function probeHttp(
  uri: string,
): Promise<{ ok: boolean; status?: number; durationMs: number; error?: string }> {
  const candidates =
    uri.startsWith('http://') || uri.startsWith('https://')
      ? [uri]
      : [`https://${uri}`, `http://${uri}`]

  for (const url of candidates) {
    const start = Date.now()
    try {
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      })
      return { ok: resp.status < 500, status: resp.status, durationMs: Date.now() - start }
    } catch (e: any) {
      if (url === candidates[candidates.length - 1]) {
        return { ok: false, durationMs: Date.now() - start, error: e.message?.slice(0, 200) }
      }
    }
  }
  return { ok: false, durationMs: 0, error: 'no candidates' }
}

// ── Core: deploy a single template ───────────────────────────────────

async function deployTemplate(
  templateId: string,
  opts: {
    projectId?: string
    provider: string
    close: boolean
    envOverrides: Record<string, string>
    healthTimeoutS: number
  },
): Promise<TestResult> {
  const totalStart = Date.now()
  const steps: StepResult[] = []

  const record = (step: string, status: StepStatus, durationMs: number, detail: string) => {
    steps.push({ step, status, durationMs, detail })
    const icon = status === 'OK' ? '[OK]' : `[${status}]`
    console.log(`\n  ${icon} ${step} (${durationMs}ms) -- ${detail}`)
  }

  const mkResult = (extra: Partial<TestResult> = {}): TestResult => ({
    templateId,
    templateName: '',
    composite: false,
    provider: opts.provider,
    passed: steps.length > 0 && steps.every((s) => s.status === 'OK'),
    totalMs: Date.now() - totalStart,
    steps: [...steps],
    ...extra,
  })

  // ── Step 0: Validate template ──────────────────────────────────
  banner('STEP 0', `Validate template "${templateId}"`)
  const template = getTemplateById(templateId)
  if (!template) {
    console.error(`  Template "${templateId}" not found.`)
    record('VALIDATE', 'FAIL', 0, 'Template not found')
    return mkResult()
  }

  const isComposite = !!(template as any).components?.length
  console.log(`  Name:       ${template.name}`)
  console.log(`  Category:   ${template.category}`)
  console.log(`  Image:      ${template.dockerImage}`)
  console.log(`  Composite:  ${isComposite}`)
  if (isComposite) {
    const comps = (template as any).components as Array<{ id: string; name: string }>
    console.log(`  Components: ${comps.map((c) => `${c.id} (${c.name})`).join(', ')}`)
  }
  record('VALIDATE', 'OK', Date.now() - totalStart, `${template.name} (composite=${isComposite})`)

  // ── Step 1: Ensure project exists ──────────────────────────────
  let projectId = opts.projectId
  let createdProject = false

  if (!projectId) {
    banner('STEP 1', 'Create temporary test project')
    const projStart = Date.now()
    const projName = `e2e-test-${templateId}-${Date.now()}`
    const res = await gql(GQL_CREATE_PROJECT, {
      data: { name: projName, slug: projName },
    })
    if (res.errors?.length || !res.data?.createProject?.id) {
      const msg = res.errors?.[0]?.message ?? 'Unknown error'
      record('CREATE_PROJECT', 'FAIL', Date.now() - projStart, msg)
      return mkResult({ templateName: template.name, composite: isComposite })
    }
    projectId = res.data.createProject.id
    createdProject = true
    console.log(`  Project: ${projName} (${projectId})`)
    record('CREATE_PROJECT', 'OK', Date.now() - projStart, projectId)
  } else {
    record('CREATE_PROJECT', 'SKIP', 0, `Using existing project ${projectId}`)
  }

  let serviceId: string | undefined

  try {
    // ── Step 2: Deploy ─────────────────────────────────────────────
    banner('STEP 2', `Deploy via GraphQL (${isComposite ? 'composite' : 'simple'})`)
    const deployStart = Date.now()

    const envOverridesList = Object.entries(opts.envOverrides).map(([key, value]) => ({
      key,
      value,
    }))

    if (isComposite) {
      const res = await gql(GQL_DEPLOY_COMPOSITE, {
        input: {
          templateId,
          projectId,
          mode: 'fullstack',
          provider: opts.provider,
          envOverrides: envOverridesList.length > 0 ? envOverridesList : undefined,
        },
      })
      if (res.errors?.length || !res.data?.deployCompositeTemplate?.primaryServiceId) {
        const msg = res.errors?.[0]?.message ?? 'Unknown error'
        record('DEPLOY', 'FAIL', Date.now() - deployStart, msg.slice(0, 300))
        return mkResult({ templateName: template.name, composite: isComposite })
      }
      serviceId = res.data.deployCompositeTemplate.primaryServiceId
      console.log(`  Primary Service ID: ${serviceId}`)
      record('DEPLOY', 'OK', Date.now() - deployStart, `serviceId=${serviceId}`)
    } else {
      const res = await gql(GQL_DEPLOY_SIMPLE, {
        input: {
          templateId,
          projectId,
          envOverrides: envOverridesList.length > 0 ? envOverridesList : undefined,
        },
      })
      if (res.errors?.length || !res.data?.deployFromTemplate) {
        const msg = res.errors?.[0]?.message ?? 'Unknown error'
        record('DEPLOY', 'FAIL', Date.now() - deployStart, msg.slice(0, 300))
        return mkResult({ templateName: template.name, composite: isComposite })
      }
      const dep = res.data.deployFromTemplate
      console.log(`  Deployment: dseq=${dep.dseq} status=${dep.status}`)
      if (dep.errorMessage) console.log(`  Error: ${dep.errorMessage}`)

      // We need the serviceId — fetch it from the registry
      const regRes = await gql(GQL_SERVICE_REGISTRY)
      const services = (regRes.data?.serviceRegistry ?? []) as Array<{
        id: string
        templateId?: string
      }>
      const svc = services.find((s: any) => s.templateId === templateId)
      serviceId = svc?.id
      console.log(`  Service ID: ${serviceId ?? 'not found in registry'}`)
      record('DEPLOY', 'OK', Date.now() - deployStart, `dseq=${dep.dseq}`)
    }

    if (!serviceId) {
      record('RESOLVE_SERVICE', 'FAIL', 0, 'Could not determine service ID')
      return mkResult({ templateName: template.name, composite: isComposite })
    }

    // ── Step 3: Poll deployment health ─────────────────────────────
    banner('STEP 3', `Poll deployment health (timeout=${opts.healthTimeoutS}s)`)
    const healthStart = Date.now()
    const healthDeadline = healthStart + opts.healthTimeoutS * 1000
    let lastHealth: DeploymentHealth | null = null
    let healthy = false
    let pollCount = 0

    // Start slow, speed up once containers appear
    const initialDelay = 15_000
    const pollInterval = 10_000

    console.log(`  Waiting ${initialDelay / 1000}s for initial deployment setup...`)
    await sleep(initialDelay)

    while (Date.now() < healthDeadline) {
      pollCount++
      try {
        const res = await gql(GQL_DEPLOYMENT_HEALTH, { serviceId })
        const h = res.data?.deploymentHealth as DeploymentHealth | null

        if (h) {
          lastHealth = h
          const containers = h.containers
            .map((c) => {
              const status = c.ready ? 'READY' : c.status.toUpperCase()
              const msg = c.message ? ` (${c.message.slice(0, 60)})` : ''
              return `${c.name}:${status} ${c.available}/${c.total}${msg}`
            })
            .join(' | ')

          console.log(
            `  [${pollCount}] overall=${h.overall} | ${containers || 'no containers'}`,
          )

          if (h.overall === 'healthy') {
            healthy = true
            break
          }

          if (h.overall === 'unhealthy') {
            const crashed = h.containers.filter(
              (c) => c.status === 'crashed' || c.status === 'image_error',
            )
            if (crashed.length > 0) {
              console.log(`  Containers crashed/image_error — aborting early`)
              break
            }
          }
        } else {
          console.log(`  [${pollCount}] No health data yet (deployment still provisioning)`)
        }
      } catch (e: any) {
        console.log(`  [${pollCount}] Health query error: ${e.message?.slice(0, 150)}`)
      }

      if (Date.now() + pollInterval > healthDeadline) break
      await sleep(pollInterval)
    }

    const healthDuration = Date.now() - healthStart
    if (healthy) {
      record('HEALTH', 'OK', healthDuration, `All containers healthy after ${pollCount} polls`)
    } else if (lastHealth) {
      const failedContainers = lastHealth.containers
        .filter((c) => !c.ready)
        .map((c) => `${c.name}:${c.status}`)
        .join(', ')
      record(
        'HEALTH',
        lastHealth.overall === 'starting' ? 'TIMEOUT' : 'FAIL',
        healthDuration,
        `overall=${lastHealth.overall} not-ready=[${failedContainers}]`,
      )
    } else {
      record('HEALTH', 'TIMEOUT', healthDuration, 'No health data received within timeout')
    }

    // ── Step 4: Probe endpoints ──────────────────────────────────
    const endpoints: Record<string, string[]> = {}
    if (lastHealth && lastHealth.containers.length > 0) {
      banner('STEP 4', 'Probe endpoints')
      const probeStart = Date.now()
      let allOk = true

      for (const c of lastHealth.containers) {
        if (c.uris.length === 0) continue
        endpoints[c.name] = c.uris
        for (const uri of c.uris) {
          const result = await probeHttp(uri)
          const status = result.ok
            ? `OK status=${result.status}`
            : `FAIL ${result.error ?? `status=${result.status}`}`
          console.log(`  ${c.name} -> ${uri}: ${status} (${result.durationMs}ms)`)
          if (!result.ok) allOk = false
        }
      }

      record(
        'PROBE',
        allOk ? 'OK' : 'FAIL',
        Date.now() - probeStart,
        `${Object.keys(endpoints).length} service(s) probed`,
      )
    }

    // ── Report ───────────────────────────────────────────────────
    return mkResult({
      templateName: template.name,
      composite: isComposite,
      serviceId,
      health: lastHealth ?? undefined,
      endpoints: Object.keys(endpoints).length > 0 ? endpoints : undefined,
    })
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────
    if (opts.close && serviceId) {
      try {
        banner('CLEANUP', 'Close deployment')
        const regRes = await gql(GQL_SERVICE_REGISTRY)
        const services = (regRes.data?.serviceRegistry ?? []) as Array<{
          id: string
          parentServiceId?: string
          akashDeployments?: Array<{ id: string; status: string }>
          phalaDeployments?: Array<{ id: string; status: string }>
        }>

        // Find all services related to this deployment (parent + children)
        const related = services.filter(
          (s: any) => s.id === serviceId || s.parentServiceId === serviceId,
        )

        for (const svc of related) {
          const activeAkash = (svc.akashDeployments ?? []).filter(
            (d: any) => d.status === 'ACTIVE',
          )
          for (const dep of activeAkash) {
            console.log(`  Closing Akash deployment ${dep.id}...`)
            await gql(GQL_CLOSE_AKASH, { id: dep.id })
          }
        }
        console.log(`  Deployments closed.`)
      } catch (e: any) {
        console.log(`  Cleanup error: ${e.message?.slice(0, 200)}`)
      }
    }

    if (createdProject && projectId && opts.close) {
      try {
        console.log(`  Deleting test project ${projectId}...`)
        await gql(GQL_DELETE_PROJECT, { id: projectId })
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── Health command ────────────────────────────────────────────────────

async function cmdHealth(serviceId: string) {
  banner('HEALTH', `Live health for service ${serviceId}`)
  const res = await gql(GQL_DEPLOYMENT_HEALTH, { serviceId })
  const h = res.data?.deploymentHealth as DeploymentHealth | null

  if (!h) {
    console.log('  No health data available.')
    return
  }

  console.log(`  Provider: ${h.provider}`)
  console.log(`  Overall:  ${h.overall}`)
  console.log(`  Checked:  ${h.lastChecked}`)
  console.log('')

  for (const c of h.containers) {
    const readyStr = c.ready ? 'READY' : 'NOT READY'
    console.log(`  ${c.name}:`)
    console.log(`    Status:   ${c.status} (${readyStr})`)
    console.log(`    Replicas: ${c.available}/${c.total}`)
    if (c.uris.length > 0) console.log(`    URIs:     ${c.uris.join(', ')}`)
    if (c.message) console.log(`    Message:  ${c.message}`)
  }
}

// ── List command ─────────────────────────────────────────────────────

function cmdList() {
  banner('TEMPLATES', 'Available templates')
  const templates = getAllTemplates()
  console.log(`  ${templates.length} templates:\n`)

  for (const t of templates) {
    const composite = !!(t as any).components?.length
    const gpu = t.resources.gpu
      ? ` GPU:${t.resources.gpu.units}x${t.resources.gpu.vendor}`
      : ''
    const compLabel = composite
      ? ` [composite: ${((t as any).components as any[]).length} components]`
      : ''
    console.log(
      `  ${t.id.padEnd(25)} ${t.name.padEnd(30)} ${t.category.padEnd(12)}${compLabel}${gpu}`,
    )
  }
}

// ── Test-all command ─────────────────────────────────────────────────

async function cmdTestAll(opts: {
  provider: string
  includeGpu: boolean
  healthTimeoutS: number
  projectId?: string
}) {
  const templates = getAllTemplates()
  const toTest = opts.includeGpu
    ? templates
    : templates.filter((t) => !t.resources.gpu)

  console.log('\n' + '='.repeat(70))
  console.log('  E2E TEST-ALL: Deploy every template via GraphQL API')
  console.log('='.repeat(70))
  console.log(`  API:       ${API_URL}`)
  console.log(`  Provider:  ${opts.provider}`)
  console.log(`  Templates: ${toTest.length}/${templates.length} (${opts.includeGpu ? 'including' : 'excluding'} GPU)`)
  console.log(`  Timeout:   ${opts.healthTimeoutS}s per template`)
  console.log('')

  const results: TestResult[] = []

  for (let i = 0; i < toTest.length; i++) {
    const t = toTest[i]
    console.log(`\n${'~'.repeat(70)}`)
    console.log(`  [${i + 1}/${toTest.length}] Testing: ${t.id} (${t.name})`)
    console.log(`${'~'.repeat(70)}`)

    let result: TestResult
    try {
      result = await deployTemplate(t.id, {
        projectId: opts.projectId,
        provider: opts.provider,
        close: true,
        envOverrides: {},
        healthTimeoutS: opts.healthTimeoutS,
      })
    } catch (e: any) {
      result = {
        templateId: t.id,
        templateName: t.name,
        composite: !!(t as any).components?.length,
        provider: opts.provider,
        passed: false,
        totalMs: 0,
        steps: [],
        error: e.message || String(e),
      }
    }
    results.push(result)

    console.log(`\n  >> ${t.id}: ${result.passed ? 'PASSED' : 'FAILED'}`)

    if (i < toTest.length - 1) await sleep(5_000)
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(70))
  console.log('  E2E TEST-ALL SUMMARY')
  console.log('='.repeat(70))

  const passed = results.filter((r) => r.passed)
  const failed = results.filter((r) => !r.passed)

  console.log(`\n  Passed: ${passed.length}/${results.length}`)
  for (const p of passed) {
    console.log(`    + ${p.templateId} (${p.templateName})`)
  }

  if (failed.length > 0) {
    console.log(`\n  Failed: ${failed.length}/${results.length}`)
    for (const f of failed) {
      const failSteps = f.steps.filter((s) => s.status !== 'OK' && s.status !== 'SKIP')
      const reason =
        failSteps.length > 0
          ? failSteps.map((s) => `${s.step}: ${s.detail}`).join('; ')
          : f.error || 'unknown'
      console.log(`    - ${f.templateId}: ${reason.slice(0, 150)}`)
    }
  }

  console.log('\n' + '='.repeat(70))
  process.exit(failed.length > 0 ? 1 : 0)
}

// ── Print report ─────────────────────────────────────────────────────

function printReport(result: TestResult) {
  console.log('\n' + '='.repeat(70))
  console.log('  E2E DEPLOYMENT TEST REPORT')
  console.log('='.repeat(70))
  console.log(`  Template:   ${result.templateId} (${result.templateName})`)
  console.log(`  Composite:  ${result.composite}`)
  console.log(`  Provider:   ${result.provider}`)
  console.log(`  Service ID: ${result.serviceId ?? 'N/A'}`)
  console.log(`  Total time: ${(result.totalMs / 1000).toFixed(1)}s`)
  console.log('')
  console.log('  Step Results:')
  for (const r of result.steps) {
    const icon = r.status === 'OK' ? 'PASS' : r.status
    console.log(
      `    ${icon.padEnd(7)} ${r.step.padEnd(20)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${r.detail}`,
    )
  }
  console.log('')

  if (result.health) {
    console.log('  Container Health:')
    for (const c of result.health.containers) {
      const readyStr = c.ready ? 'READY' : 'NOT READY'
      console.log(
        `    ${c.name.padEnd(20)} ${c.status.padEnd(10)} ${readyStr.padEnd(10)} ${c.available}/${c.total} replicas  ${c.uris.join(', ')}`,
      )
      if (c.message) console.log(`${''.padEnd(26)}${c.message}`)
    }
    console.log('')
  }

  if (result.passed) {
    console.log('  RESULT: ALL STEPS PASSED')
  } else {
    const failed = result.steps.filter((s) => s.status !== 'OK' && s.status !== 'SKIP')
    console.log(`  RESULT: ${failed.length} STEP(S) FAILED`)
    for (const f of failed) console.log(`    - ${f.step}: ${f.detail}`)
  }
  console.log('='.repeat(70))
}

// ── CLI parsing ──────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  const command = args[0]

  const getFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name)
    return idx >= 0 ? args[idx + 1] : undefined
  }

  const hasFlag = (name: string): boolean => args.includes(name)

  const envOverrides: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      const [k, ...vParts] = args[i + 1].split('=')
      envOverrides[k] = vParts.join('=')
      i++
    }
  }

  return {
    command,
    templateId: args[1],
    projectId: getFlag('--project-id'),
    provider: getFlag('--provider') ?? 'akash',
    close: hasFlag('--close'),
    apiUrl: getFlag('--api-url') ?? process.env.AF_API_URL ?? 'https://api.alternatefutures.ai',
    token: getFlag('--token') ?? process.env.AF_TEST_TOKEN ?? '',
    healthTimeoutS: parseInt(getFlag('--timeout') ?? '300', 10),
    includeGpu: !hasFlag('--no-gpu'),
    envOverrides,
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv)

  if (!opts.command || opts.command === '--help' || opts.command === '-h') {
    console.log(`
  AF E2E Template Test Tool (GraphQL API)

  Usage:
    bun scripts/test-template-e2e.ts deploy <template-id> [options]
    bun scripts/test-template-e2e.ts test-all [options]
    bun scripts/test-template-e2e.ts health <service-id>
    bun scripts/test-template-e2e.ts list

  Options:
    --project-id <id>     Use existing project (default: creates temp project)
    --provider <name>     Provider: 'akash' (default) or 'phala'
    --close               Close deployment after test
    --env KEY=VAL         Override env vars (repeatable)
    --api-url <url>       GraphQL API URL (default: https://api.alternatefutures.ai)
    --token <jwt>         Auth token (or set AF_TEST_TOKEN env var)
    --timeout <seconds>   Health poll timeout (default: 300)
    --no-gpu              Skip GPU templates in test-all

  Environment:
    AF_TEST_TOKEN         JWT access token for authentication
    AF_API_URL            GraphQL API URL override
    `)
    process.exit(0)
  }

  API_URL = opts.apiUrl
  AUTH_TOKEN = opts.token

  if (!AUTH_TOKEN && opts.command !== 'list') {
    console.error(
      'Auth token required. Set AF_TEST_TOKEN env var or use --token <jwt>.',
    )
    console.error(
      'Get a token: log into the web app, open DevTools > Application > Cookies, copy af_access_token.',
    )
    process.exit(1)
  }

  switch (opts.command) {
    case 'deploy': {
      if (!opts.templateId) {
        console.error('Usage: deploy <template-id>')
        process.exit(1)
      }
      const result = await deployTemplate(opts.templateId, {
        projectId: opts.projectId,
        provider: opts.provider,
        close: opts.close,
        envOverrides: opts.envOverrides,
        healthTimeoutS: opts.healthTimeoutS,
      })
      printReport(result)
      process.exit(result.passed ? 0 : 1)
      break
    }

    case 'test-all': {
      await cmdTestAll({
        provider: opts.provider,
        includeGpu: opts.includeGpu,
        healthTimeoutS: opts.healthTimeoutS,
        projectId: opts.projectId,
      })
      break
    }

    case 'health': {
      const serviceId = opts.templateId
      if (!serviceId) {
        console.error('Usage: health <service-id>')
        process.exit(1)
      }
      await cmdHealth(serviceId)
      break
    }

    case 'list':
      cmdList()
      break

    default:
      console.error(`Unknown command: ${opts.command}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
