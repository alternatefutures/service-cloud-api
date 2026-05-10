/**
 * Spheron REST API client.
 *
 * Wraps app.spheron.ai's HTTP API behind a typed surface. Single shared platform
 * team — every AF user deployment debits this team's balance. Auth is a long-
 * lived `sai_pk_…` key in the `Authorization: Bearer …` header.
 *
 * See:
 *   admin/cloud/docs/AF_SPHERON_API_REFERENCE.md  — endpoint cheat-sheet
 *   admin/cloud/docs/AF_HANDOFF_2026-05-06_CLI_PARITY.md  — handoff context
 *
 * Rate limits (per Spheron's developer portal — `/api-docs` is more current
 * than `/api-reference`):
 *   - Reads: 100 req / 15 min per IP   (250 in `/api-reference` — assume 100)
 *   - POST /api/deployments: 10 / 15 min per user
 * On 429 we honour `Retry-After` if present, else exponential back-off bounded
 * to 60s; we surface upstream errors verbatim so the caller can decide.
 *
 * The client is stateless apart from the lazily-resolved `SPHERON_API_KEY` /
 * `SPHERON_API_BASE` / `SPHERON_TEAM_ID` env reads — safe to construct once
 * per process via `getSpheronClient()` or per-request as needed.
 */

import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-client')

// ─── Public types (mirror Spheron's response shapes) ─────────────────

export type SpheronInstanceType = 'SPOT' | 'DEDICATED' | 'CLUSTER'

export type SpheronDeploymentNativeStatus =
  | 'deploying'
  | 'running'
  | 'failed'
  | 'terminated'
  | 'terminated-provider' // SPOT reclaim — v1 ignored, reserved for SPOT phase

export interface SpheronTeam {
  teamId: string
  teamName: string
  balance: number // USD float
  isCurrentTeam: boolean
  role: 'owner' | 'admin' | 'member' | string
}

export interface SpheronBalance {
  teams: SpheronTeam[]
  currency: 'USD'
}

export interface SpheronGpuOfferExtras {
  deployment_type?: 'vm' | 'cluster' | string
  nvlink?: boolean
  // Voltage Park CLUSTER offers only: { version: string; total_cost_per_hour: number }
  kubernetes_addon?: {
    version: string
    total_cost_per_hour: number
  }
  [key: string]: unknown
}

export interface SpheronGpuOffer {
  provider: string // "sesterce" | "voltage-park" | "data-crunch" | "verda" | "massed-compute" | "spheron-ai"
  offerId: string
  name: string
  description?: string
  vcpus: number
  memory: number // GB
  storage: number // GB
  gpuCount: number
  price: number // USD/hour for the WHOLE instance (all GPUs incl.)
  spot_price?: number // present on SPOT offers only
  available: boolean
  clusters: string[] // region IDs (passed as `region` on deploy)
  gpu_memory: number // VRAM per GPU, GB
  os_options: string[] // Verbatim strings used on POST /api/deployments `operatingSystem`
  interconnectType?: string // SXM5, PCIe, etc.
  instanceType: SpheronInstanceType
  supportsCloudInit: boolean // CRITICAL — false on some Sesterce offers
  extras?: SpheronGpuOfferExtras
}

export interface SpheronGpuOfferGroup {
  gpuType: string
  gpuModel: string
  displayName: string
  totalAvailable: number
  lowestPrice: number
  highestPrice: number
  averagePrice: number
  providers: string[]
  offers: SpheronGpuOffer[]
}

export interface SpheronGpuOffersResponse {
  data: SpheronGpuOfferGroup[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface SpheronGpuOffersFilters {
  page?: number
  limit?: number
  search?: string
  sortBy?: 'lowestPrice' | 'highestPrice' | 'averagePrice'
  sortOrder?: 'asc' | 'desc'
  instanceType?: SpheronInstanceType
}

export interface SpheronSshKey {
  id: string
  name: string
  fingerprint: string
  publicKey?: string
  createdAt?: string
}

export interface SpheronCloudInit {
  packages?: string[]
  writeFiles?: Array<{
    path: string
    content: string
    owner?: string
    permissions?: string // octal string e.g. "0644"
    encoding?: 'b64' | 'gzip' | 'gz+b64'
  }>
  runcmd?: string[]
}

export interface SpheronCreateDeploymentInput {
  provider: string
  offerId: string
  gpuType: string
  gpuCount: number
  region: string
  operatingSystem: string
  instanceType: SpheronInstanceType
  // Provide either sshKeyId (preferred — pre-registered) or ssh_public_key (ephemeral).
  sshKeyId?: string
  ssh_public_key?: string
  teamId?: string
  name: string
  cloudInit?: SpheronCloudInit
  kubernetesAddon?: {
    version: string
    authentication_config_b64: string
  }
}

export interface SpheronDeploymentObject {
  id: string
  name: string
  providerId: string // Upstream provider name, sometimes id-suffixed
  gpuModelId: string
  gpuCount: number
  region: string
  instanceType: SpheronInstanceType
  sshKeyId: string | null
  tempSshKeyId: string | null
  sshKeyName: string | null
  sshKeyFingerprint: string | null
  ipAddress: string | null
  user: string | null
  status: SpheronDeploymentNativeStatus
  startedAt: string | null
  stoppedAt: string | null
  lastCreditDeduction: string | null
  totalCost: number
  hourlyRate: number
  originalHourlyRate: number
  discountPercentage: number
  hasDiscount: boolean
  vcpus: number
  memory: number
  storage: number
  sshCommand: string | null
  sshPort: number | null
  portForwards?: Array<{ external: number; internal: number }>
  kubernetesAddon?: {
    version: string
    kubeconfig?: string
    [key: string]: unknown
  } | null
  createdAt: string
}

export interface SpheronCanTerminateResponse {
  canTerminate: boolean
  reason?: string
}

export interface SpheronDeleteResponse {
  message: string
  deployment: Pick<SpheronDeploymentObject, 'id' | 'status' | 'stoppedAt'>
}

// ─── Errors ──────────────────────────────────────────────────────────

export class SpheronApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'SpheronApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /**
   * "Already gone" detection — used by close()/stop() paths to treat a 404
   * (or text/details matching the phrases below) as success per the
   * lifecycle-safety contract. Matches the project-wide pattern (mirrors
   * phalaProvider.close and akashProvider.close).
   *
   * Spheron-specific phrasing observed live (2026-05-07): a DELETE on a
   * VM that the upstream already considers terminated returns:
   *   400 {
   *     error: 'Cannot terminate instance',
   *     message: 'Instance has already been terminated.',
   *     currentStatus: 'terminated',
   *     canTerminate: false,
   *   }
   * The structured `currentStatus: 'terminated'` is the authoritative
   * signal — checked first because the message string drifts across
   * upstream versions. The regex below covers historical phrasings and
   * any future wording that includes "already terminated", "already gone",
   * "instance has been ... terminated", etc.
   */
  isAlreadyGone(): boolean {
    if (this.status === 404) return true
    const details = this.details as Record<string, unknown> | undefined
    const currentStatus = details?.currentStatus
    if (typeof currentStatus === 'string' && currentStatus.toLowerCase() === 'terminated') {
      return true
    }
    return /not found|does not exist|already stopped|already deleted|already (?:been )?terminated|already gone|no such/i.test(
      this.message,
    )
  }

  /**
   * Spheron enforces a 20-minute server-side minimum runtime. DELETE on a
   * VM younger than that returns:
   *   400 { error: 'Minimum runtime not met',
   *         message: 'Instance must run for at least 20 minutes. Time remaining: N minutes.',
   *         canTerminate: false, timeRemaining: N, minimumRuntime: 20 }
   * Surfaced verbatim so the provider adapter and the sweeper can defer
   * upstream cleanup until the floor is satisfied (see Phase A patch
   * 2026-05-06: spheronDeployment.upstreamDeletedAt + sweeper retry pass).
   *
   * Returns the parsed timeRemaining in minutes when the response matches,
   * else null. Resilient to message-string drift — checks the structured
   * `details` object first.
   */
  isMinimumRuntimeNotMet(): { timeRemainingMinutes: number } | null {
    if (this.status !== 400) return null
    const details = this.details as Record<string, unknown> | undefined
    const timeRemaining = details?.timeRemaining
    const canTerminate = details?.canTerminate
    if (
      typeof timeRemaining === 'number' &&
      Number.isFinite(timeRemaining) &&
      timeRemaining >= 0 &&
      canTerminate === false
    ) {
      return { timeRemainingMinutes: Math.ceil(timeRemaining) }
    }
    // String-match fallback for message drift across upstream versions.
    const m = this.message.match(/time\s+remaining:\s+(\d+)/i)
    if (m && /minimum\s+runtime/i.test(this.message)) {
      return { timeRemainingMinutes: Math.ceil(Number(m[1])) }
    }
    return null
  }
}

// ─── Client ──────────────────────────────────────────────────────────

interface SpheronClientOptions {
  apiKey: string
  apiBase: string
  teamId?: string
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number
  /** Max 429/5xx retries. Default 3. */
  maxRetries?: number
}

export class SpheronClient {
  private readonly apiKey: string
  private readonly apiBase: string
  readonly teamId: string | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(opts: SpheronClientOptions) {
    if (!opts.apiKey) {
      throw new Error('SpheronClient: apiKey is required')
    }
    if (!opts.apiBase) {
      throw new Error('SpheronClient: apiBase is required')
    }
    this.apiKey = opts.apiKey
    this.apiBase = opts.apiBase.replace(/\/+$/, '')
    this.teamId = opts.teamId
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxRetries = opts.maxRetries ?? 3
  }

  // ── Account ───────────────────────────────────────────────────

  /** GET /api/balance — used by the health monitor + pre-deploy supply-side gate. */
  async getBalance(): Promise<SpheronBalance> {
    return this.request<SpheronBalance>('GET', '/api/balance')
  }

  /**
   * Resolve the current team's USD balance, falling back to the configured
   * `SPHERON_TEAM_ID` if `isCurrentTeam` isn't reliably set on the response.
   * Returns null when the team isn't on the account at all (caller should
   * opsAlert).
   */
  async getCurrentTeamBalance(): Promise<{ teamId: string; balance: number; teamName: string } | null> {
    const balance = await this.getBalance()
    const matchById = this.teamId
      ? balance.teams.find(t => t.teamId === this.teamId)
      : undefined
    const matchByCurrent = balance.teams.find(t => t.isCurrentTeam)
    const team = matchById ?? matchByCurrent ?? balance.teams[0]
    if (!team) return null
    return { teamId: team.teamId, balance: team.balance, teamName: team.teamName }
  }

  // ── Provider catalogue ────────────────────────────────────────

  /**
   * GET /api/providers — live list. Use this instead of hardcoding the set;
   * the `data-crunch` ↔ `verda` rename and `tensordock` deprecation are real
   * changes that surface here first.
   */
  async listProviders(): Promise<string[]> {
    return this.request<string[]>('GET', '/api/providers')
  }

  /** GET /api/gpu-offers — live pricing source. */
  async listGpuOffers(filters: SpheronGpuOffersFilters = {}): Promise<SpheronGpuOffersResponse> {
    const search = new URLSearchParams()
    if (filters.page) search.set('page', String(filters.page))
    if (filters.limit) search.set('limit', String(filters.limit))
    if (filters.search) search.set('search', filters.search)
    if (filters.sortBy) search.set('sortBy', filters.sortBy)
    if (filters.sortOrder) search.set('sortOrder', filters.sortOrder)
    if (filters.instanceType) search.set('instanceType', filters.instanceType)
    const qs = search.toString()
    return this.request<SpheronGpuOffersResponse>(
      'GET',
      `/api/gpu-offers${qs ? `?${qs}` : ''}`,
    )
  }

  // ── SSH keys ──────────────────────────────────────────────────

  async listSshKeys(): Promise<SpheronSshKey[]> {
    return this.request<SpheronSshKey[]>('GET', '/api/ssh-keys')
  }

  async getSshKey(id: string): Promise<SpheronSshKey> {
    return this.request<SpheronSshKey>('GET', `/api/ssh-keys/${encodeURIComponent(id)}`)
  }

  async createSshKey(input: { name: string; publicKey: string; teamId?: string }): Promise<SpheronSshKey> {
    const body: Record<string, unknown> = {
      name: input.name,
      publicKey: input.publicKey,
    }
    if (input.teamId ?? this.teamId) {
      body.teamId = input.teamId ?? this.teamId
    }
    return this.request<SpheronSshKey>('POST', '/api/ssh-keys', body)
  }

  async deleteSshKey(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/ssh-keys/${encodeURIComponent(id)}`)
  }

  // ── Deployments ───────────────────────────────────────────────

  async createDeployment(input: SpheronCreateDeploymentInput): Promise<SpheronDeploymentObject> {
    const body: SpheronCreateDeploymentInput = {
      ...input,
      teamId: input.teamId ?? this.teamId,
    }
    return this.request<SpheronDeploymentObject>('POST', '/api/deployments', body)
  }

  async getDeployment(id: string): Promise<SpheronDeploymentObject> {
    return this.request<SpheronDeploymentObject>(
      'GET',
      `/api/deployments/${encodeURIComponent(id)}`,
    )
  }

  async listDeployments(
    filters: { teamId?: string; userId?: string; status?: 'active' | 'inactive' | string } = {},
  ): Promise<SpheronDeploymentObject[]> {
    const search = new URLSearchParams()
    if (filters.teamId ?? this.teamId) {
      search.set('teamId', (filters.teamId ?? this.teamId) as string)
    }
    if (filters.userId) search.set('userId', filters.userId)
    if (filters.status) search.set('status', filters.status)
    const qs = search.toString()
    return this.request<SpheronDeploymentObject[]>(
      'GET',
      `/api/deployments${qs ? `?${qs}` : ''}`,
    )
  }

  /**
   * GET /api/deployments/{id}/can-terminate — pre-flight for safe DELETE.
   * Surface in the live `/api-docs` portal but absent from `/api-reference`;
   * the response shape is inferred and may need a probe-based correction the
   * first time we exercise it. We treat any non-2xx as "unknown — proceed
   * to delete" and let DELETE's own `isAlreadyGone()` short-circuit handle it.
   */
  async canTerminate(id: string): Promise<SpheronCanTerminateResponse | null> {
    try {
      return await this.request<SpheronCanTerminateResponse>(
        'GET',
        `/api/deployments/${encodeURIComponent(id)}/can-terminate`,
      )
    } catch (err) {
      log.warn({ id, err }, 'can-terminate probe failed; falling back to direct DELETE')
      return null
    }
  }

  async deleteDeployment(id: string): Promise<SpheronDeleteResponse> {
    return this.request<SpheronDeleteResponse>(
      'DELETE',
      `/api/deployments/${encodeURIComponent(id)}`,
    )
  }

  // ── Internal: HTTP layer ──────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`
    let lastErr: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })
        clearTimeout(timeout)

        // Read body even on non-2xx so error messages carry useful detail.
        const text = await res.text()
        let payload: unknown
        try {
          payload = text ? JSON.parse(text) : undefined
        } catch {
          payload = text || undefined
        }

        if (res.ok) {
          return (payload as T) ?? (undefined as T)
        }

        // 429 / 5xx → transient, retry with back-off
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const baseDelay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 60_000)
          // Jitter ±25% to avoid thundering-herd retry storms across replicas.
          const jitter = baseDelay * (0.75 + Math.random() * 0.5)
          log.warn(
            { method, path, status: res.status, attempt, delayMs: Math.round(jitter) },
            'spheron-client: transient error, retrying',
          )
          await sleep(jitter)
          continue
        }

        const message = extractErrorMessage(payload, res.statusText)
        const code = extractErrorCode(payload)
        throw new SpheronApiError(
          `Spheron ${method} ${path} → ${res.status}: ${message}`,
          res.status,
          code,
          payload,
        )
      } catch (err) {
        clearTimeout(timeout)
        // Surface SpheronApiError unchanged. Retry on AbortError / fetch failure
        // up to maxRetries.
        if (err instanceof SpheronApiError) throw err
        if (attempt < this.maxRetries) {
          const delay = Math.min(500 * 2 ** attempt, 30_000)
          log.warn(
            { method, path, attempt, err: (err as Error).message },
            'spheron-client: network error, retrying',
          )
          lastErr = err
          await sleep(delay)
          continue
        }
        throw err
      }
    }

    // Unreachable — the loop either returns or throws — but keep TS happy.
    throw lastErr instanceof Error ? lastErr : new Error('Spheron request exhausted retries')
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    if (obj.error && typeof obj.error === 'object') {
      const err = obj.error as Record<string, unknown>
      if (typeof err.message === 'string') return err.message
    }
  }
  return fallback
}

function extractErrorCode(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.code === 'string') return obj.code
  }
  return undefined
}

// ─── Singleton accessor ──────────────────────────────────────────────

let _instance: SpheronClient | null = null

/**
 * Lazily-constructed singleton reading from env. Returns null when the
 * provider isn't configured (mirrors `phalaProvider.isAvailable`); callers
 * gate on this before scheduling work.
 */
export function getSpheronClient(): SpheronClient | null {
  if (_instance) return _instance
  const apiKey = process.env.SPHERON_API_KEY
  const apiBase = process.env.SPHERON_API_BASE || 'https://app.spheron.ai'
  const teamId = process.env.SPHERON_TEAM_ID
  if (!apiKey) return null
  _instance = new SpheronClient({ apiKey, apiBase, teamId })
  return _instance
}

/** Re-resolve the singleton — used by tests + post-secret-rotation paths. */
export function resetSpheronClient(): void {
  _instance = null
}
