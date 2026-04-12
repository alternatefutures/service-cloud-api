import { execAsync } from '../queue/asyncExec.js'
import type { TemplateResources } from '../../templates/schema.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('phala-instance-types')

export type PhalaInstanceType = {
  id: string
  name: string
  description?: string
  vcpu: number
  memory_mb: number
  hourly_rate: string
  requires_gpu: boolean
  default_disk_size_gb?: number
  family: 'cpu' | 'gpu'
}

type PhalaInstanceTypeResponse = {
  success?: boolean
  result?: Array<{
    name: string
    items?: PhalaInstanceType[]
  }>
}

type ResolvedPhalaInstanceType = {
  cvmSize: string
  gpuModel: string | null
  gpuCount: number
  hourlyRateUsd: number
}

const INSTANCE_TYPES_TTL_MS = 5 * 60_000
const CLI_TIMEOUT_MS = 10_000

let cachedInstanceTypes: {
  types: PhalaInstanceType[]
  fetchedAt: number
} | null = null

// Hardcoded fallback catalog — used when the CLI is unreachable or times out.
// Rates sourced from phala instance-types output 2026-03-28.
const FALLBACK_INSTANCE_TYPES: PhalaInstanceType[] = [
  {
    id: 'tdx.small',
    name: 'small',
    vcpu: 1,
    memory_mb: 2048,
    hourly_rate: '0.058000',
    requires_gpu: false,
    family: 'cpu',
  },
  {
    id: 'tdx.medium',
    name: 'medium',
    vcpu: 2,
    memory_mb: 4096,
    hourly_rate: '0.116000',
    requires_gpu: false,
    family: 'cpu',
  },
  {
    id: 'tdx.large',
    name: 'large',
    vcpu: 4,
    memory_mb: 8192,
    hourly_rate: '0.232000',
    requires_gpu: false,
    family: 'cpu',
  },
  {
    id: 'tdx.xlarge',
    name: 'xlarge',
    vcpu: 8,
    memory_mb: 16384,
    hourly_rate: '0.464000',
    requires_gpu: false,
    family: 'cpu',
  },
  {
    id: 'h100.small',
    name: 'H100',
    vcpu: 16,
    memory_mb: 131072,
    hourly_rate: '2.800000',
    requires_gpu: true,
    family: 'gpu',
  },
  {
    id: 'h200.small',
    name: 'H200',
    vcpu: 24,
    memory_mb: 196608,
    hourly_rate: '3.500000',
    requires_gpu: true,
    family: 'gpu',
  },
  {
    id: 'h200.8x.large',
    name: 'H200 x8',
    vcpu: 192,
    memory_mb: 1572864,
    hourly_rate: '23.040000',
    requires_gpu: true,
    family: 'gpu',
  },
  {
    id: 'b200.small',
    name: 'B200',
    vcpu: 32,
    memory_mb: 262144,
    hourly_rate: '4.200000',
    requires_gpu: true,
    family: 'gpu',
  },
]

function getPhalaEnv(): Record<string, string> {
  const key = process.env.PHALA_API_KEY || process.env.PHALA_CLOUD_API_KEY
  if (!key) throw new Error('PHALA_API_KEY or PHALA_CLOUD_API_KEY is not set')
  return {
    ...(process.env as Record<string, string>),
    PHALA_CLOUD_API_KEY: key,
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const objIdx = trimmed.indexOf('{')
    const arrIdx = trimmed.indexOf('[')
    const startIdx =
      objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
    if (startIdx === -1) {
      throw new SyntaxError(
        `No JSON found in CLI output: ${trimmed.slice(0, 200)}`
      )
    }
    return JSON.parse(trimmed.slice(startIdx))
  }
}

/**
 * Convert a Kubernetes-style memory string to MiB.
 *
 * Supports both IEC binary units (Ki, Mi, Gi, Ti — powers of 1024)
 * and SI decimal units (K, M, G, T — powers of 1000, converted to MiB).
 * All template resources use binary units (e.g. "4Gi"), so the IEC path
 * is the one exercised in practice.
 */
export function parseMemoryToMb(value: string): number {
  const match = value.trim().match(/^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T|B)?$/i)
  if (!match) {
    throw new Error(`Unsupported memory value: ${value}`)
  }

  const amount = parseFloat(match[1])
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid memory amount: ${value}`)
  }

  const unit = (match[2] || 'B').toUpperCase()

  // IEC binary units → MiB (1 KiB = 1024 B, 1 MiB = 1024 KiB, etc.)
  // SI decimal units → convert bytes to MiB (1 KB = 1000 B)
  const toMib: Record<string, number> = {
    B: 1 / (1024 * 1024),
    K: 1000 / (1024 * 1024),
    M: 1000 ** 2 / 1024 ** 2,
    G: 1000 ** 3 / 1024 ** 2,
    T: 1000 ** 4 / 1024 ** 2,
    KI: 1 / 1024,
    MI: 1,
    GI: 1024,
    TI: 1024 ** 2,
  }

  return amount * (toMib[unit] ?? 1)
}

function normalizeGpuModel(model?: string | null): string | null {
  if (!model) return null
  return model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Infer GPU count from a Phala instance type ID.
 *
 * Convention: `<model>.<Nx>.<size>` → N GPUs, no multiplier → 1 GPU.
 * Examples: "h200.small" → 1, "h200.8x.large" → 8
 */
export function inferGpuCountFromId(id: string): number {
  const parts = id.split('.')
  for (const part of parts) {
    const m = part.match(/^(\d+)x$/i)
    if (m) return parseInt(m[1], 10)
  }
  return 1
}

function inferGpuModelFromInstanceType(id: string): string | null {
  const family = id.split('.')[0]?.trim().toLowerCase()
  return family || null
}

function compareByCostThenSize(
  a: PhalaInstanceType,
  b: PhalaInstanceType
): number {
  const costDiff = parseFloat(a.hourly_rate) - parseFloat(b.hourly_rate)
  if (costDiff !== 0) return costDiff
  const cpuDiff = a.vcpu - b.vcpu
  if (cpuDiff !== 0) return cpuDiff
  return a.memory_mb - b.memory_mb
}

export async function listPhalaInstanceTypes(): Promise<PhalaInstanceType[]> {
  if (
    cachedInstanceTypes &&
    Date.now() - cachedInstanceTypes.fetchedAt < INSTANCE_TYPES_TTL_MS
  ) {
    return cachedInstanceTypes.types
  }

  try {
    const output = await execAsync(
      'npx',
      ['phala', 'instance-types', '--json'],
      {
        env: getPhalaEnv(),
        timeout: CLI_TIMEOUT_MS,
      }
    )

    const payload = extractJson(output) as PhalaInstanceTypeResponse
    const families = payload.result ?? []
    const types = families.flatMap(family => family.items ?? [])

    log.info(
      { familyCount: families.length, typeCount: types.length, gpuCount: types.filter(t => t.requires_gpu).length, ids: types.map(t => t.id) },
      'Fetched live Phala instance types'
    )

    if (types.length > 0) {
      cachedInstanceTypes = { types, fetchedAt: Date.now() }
      return types
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'Failed to fetch live Phala instance types, using fallback catalog'
    )
  }

  log.info({ fallbackCount: FALLBACK_INSTANCE_TYPES.length }, 'Using fallback instance types')
  return FALLBACK_INSTANCE_TYPES
}

export async function resolvePhalaInstanceType(
  resources: TemplateResources,
  acceptableGpuModels?: string[],
  policyGpuUnits?: number | null
): Promise<ResolvedPhalaInstanceType> {
  const types = await listPhalaInstanceTypes()
  const requestedGpu = resources.gpu

  log.info(
    {
      totalTypes: types.length,
      gpuTypes: types.filter(t => t.requires_gpu).length,
      cpuTypes: types.filter(t => !t.requires_gpu).length,
      requestedGpu: requestedGpu ? { model: requestedGpu.model, units: requestedGpu.units } : null,
      acceptableGpuModels,
      policyGpuUnits,
    },
    'resolvePhalaInstanceType: starting resolution'
  )

  if (requestedGpu) {
    const normalizedModel = normalizeGpuModel(requestedGpu.model)
    const requiredUnits = policyGpuUnits ?? requestedGpu.units ?? 1

    let gpuTypes = types.filter(type => type.requires_gpu)
    log.info({ beforeFilter: gpuTypes.length, normalizedModel, requiredUnits }, 'GPU types before filtering')

    // Policy multi-select GPU filtering takes precedence over single-model selection
    if (acceptableGpuModels && acceptableGpuModels.length > 0) {
      const acceptableNormalized = acceptableGpuModels
        .map(m => normalizeGpuModel(m))
        .filter(Boolean) as string[]
      gpuTypes = gpuTypes.filter(type => {
        const typeModel = normalizeGpuModel(type.id)
        return (
          typeModel && acceptableNormalized.some(m => typeModel.startsWith(m))
        )
      })
      log.info({ afterPolicyFilter: gpuTypes.length, acceptableNormalized }, 'GPU types after policy model filter')
    } else if (normalizedModel) {
      gpuTypes = gpuTypes.filter(type =>
        normalizeGpuModel(type.id)?.startsWith(normalizedModel)
      )
      log.info({ afterModelFilter: gpuTypes.length, normalizedModel }, 'GPU types after single-model filter')
    }

    gpuTypes = gpuTypes.filter(
      type => inferGpuCountFromId(type.id) >= requiredUnits
    )
    log.info({ afterUnitsFilter: gpuTypes.length, requiredUnits, candidates: gpuTypes.map(t => t.id) }, 'GPU types after units filter')

    if (gpuTypes.length === 0) {
      const modelsDesc = acceptableGpuModels?.length
        ? acceptableGpuModels.join(', ')
        : (requestedGpu.model ?? 'any')
      const errMsg = `No Phala GPU instance matches: models=[${modelsDesc}], units=${requiredUnits}`
      log.error({ modelsDesc, requiredUnits, availableGpuIds: types.filter(t => t.requires_gpu).map(t => t.id) }, errMsg)
      throw new Error(errMsg)
    }

    const selected = [...gpuTypes].sort(compareByCostThenSize)[0]
    log.info({ selected: selected.id, hourlyRate: selected.hourly_rate, vcpu: selected.vcpu }, 'Resolved Phala GPU instance type')

    return {
      cvmSize: selected.id,
      gpuModel:
        requestedGpu.model ?? inferGpuModelFromInstanceType(selected.id),
      gpuCount: inferGpuCountFromId(selected.id),
      hourlyRateUsd: parseFloat(selected.hourly_rate),
    }
  }

  const requiredCpu = resources.cpu
  const requiredMemoryMb = parseMemoryToMb(resources.memory)

  const cpuCandidates = types
    .filter(type => !type.requires_gpu)
    .filter(
      type => type.vcpu >= requiredCpu && type.memory_mb >= requiredMemoryMb
    )
    .sort(compareByCostThenSize)

  log.info({ requiredCpu, requiredMemoryMb, candidates: cpuCandidates.length }, 'CPU instance type resolution')

  if (cpuCandidates.length === 0) {
    const errMsg = `No Phala CPU instance type can satisfy ${requiredCpu} vCPU / ${resources.memory} memory`
    log.error({ requiredCpu, requiredMemoryMb, availableCpuTypes: types.filter(t => !t.requires_gpu).map(t => ({ id: t.id, vcpu: t.vcpu, mem: t.memory_mb })) }, errMsg)
    throw new Error(errMsg)
  }

  const selected = cpuCandidates[0]
  log.info({ selected: selected.id, hourlyRate: selected.hourly_rate, vcpu: selected.vcpu }, 'Resolved Phala CPU instance type')

  return {
    cvmSize: selected.id,
    gpuModel: null,
    gpuCount: 0,
    hourlyRateUsd: parseFloat(selected.hourly_rate),
  }
}
