/**
 * Tests for SpheronClient HTTP retry policy.
 *
 * Pins the rule learned from the 2026-05-15 triple-deploy incident:
 *
 *   POST `/api/deployments` is NOT idempotent on Spheron's side. A client-
 *   side timeout/abort or upstream 5xx can happen after Spheron has already
 *   committed to allocating a VM. Retrying = duplicate VMs created upstream
 *   with no local tracking. The HTTP wrapper MUST therefore:
 *
 *     - retry on 429 for any verb (rate-limit means the request was NOT
 *       processed)
 *     - retry on 5xx and network errors ONLY for idempotent verbs
 *       (GET, DELETE)
 *     - throw immediately on 5xx / network / abort for POST and PATCH
 *
 * A regression that re-introduces blanket POST retries would silently
 * spawn duplicate VMs on the next slow Spheron allocation. These tests
 * are load-bearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SpheronClient, SpheronApiError } from './client.js'

let fetchMock: ReturnType<typeof vi.fn>
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeClient(overrides: Partial<ConstructorParameters<typeof SpheronClient>[0]> = {}) {
  return new SpheronClient({
    apiKey: 'sai_pk_test',
    apiBase: 'https://app.spheron.test',
    teamId: 'team_test',
    timeoutMs: 100,
    writeTimeoutMs: 100,
    maxRetries: 3,
    ...overrides,
  })
}

describe('POST /api/deployments — never retried on abort / network failure', () => {
  it('throws immediately on AbortError (timeout)', async () => {
    // Simulate a fetch that hangs forever — the AbortController inside
    // SpheronClient should fire and reject with the abort name.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const client = makeClient({ writeTimeoutMs: 20, maxRetries: 3 })
    await expect(
      client.createDeployment({
        provider: 'spheron-ai',
        offerId: 'offer-1',
        gpuType: 'RTXPRO6000_PCIE',
        gpuCount: 1,
        region: 'us-central-1',
        operatingSystem: 'Ubuntu 24.04 LTS (CUDA 13)',
        instanceType: 'DEDICATED',
        sshKeyId: 'key1',
        name: 'af-test-vm',
      }),
    ).rejects.toThrow(/aborted/i)

    // The critical assertion: exactly ONE fetch call, even though
    // maxRetries=3. POST on AbortError must NEVER retry.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws immediately on a 502 (5xx) — does not retry POST', async () => {
    fetchMock.mockResolvedValue(mockResponse(502, { error: 'upstream bad gateway' }))

    const client = makeClient({ maxRetries: 3 })
    await expect(
      client.createDeployment({
        provider: 'spheron-ai',
        offerId: 'offer-1',
        gpuType: 'A4000_PCIE',
        gpuCount: 1,
        region: 'us-central-1',
        operatingSystem: 'Ubuntu 24.04 LTS (CUDA 13)',
        instanceType: 'DEDICATED',
        sshKeyId: 'key1',
        name: 'af-test-vm',
      }),
    ).rejects.toThrowError(SpheronApiError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws immediately on a generic network failure (fetch reject)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const client = makeClient({ maxRetries: 3 })
    await expect(
      client.createDeployment({
        provider: 'spheron-ai',
        offerId: 'offer-1',
        gpuType: 'A4000_PCIE',
        gpuCount: 1,
        region: 'us-central-1',
        operatingSystem: 'Ubuntu 24.04 LTS (CUDA 13)',
        instanceType: 'DEDICATED',
        sshKeyId: 'key1',
        name: 'af-test-vm',
      }),
    ).rejects.toThrow(/fetch failed/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST — retries on 429 (rate-limit) because the request was provably not processed', () => {
  it('retries POST on 429 up to maxRetries, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { error: 'rate limited' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockResponse(429, { error: 'rate limited' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          id: '6a012345',
          name: 'af-test-vm',
          providerId: 'spheron-ai',
          gpuModelId: 'A4000_PCIE',
          gpuCount: 1,
          region: 'us-central-1',
          instanceType: 'DEDICATED',
          sshKeyId: 'key1',
          tempSshKeyId: null,
          sshKeyName: null,
          sshKeyFingerprint: null,
          ipAddress: null,
          user: null,
          status: 'deploying',
          startedAt: null,
          stoppedAt: null,
          lastCreditDeduction: null,
          totalCost: 0,
          hourlyRate: 0,
          originalHourlyRate: 0,
          discountPercentage: 0,
          hasDiscount: false,
          vcpus: 0,
          memory: 0,
          storage: 0,
          sshCommand: null,
          sshPort: null,
          createdAt: '2026-05-15T11:43:31Z',
        }),
      )

    const client = makeClient({ maxRetries: 3 })
    const result = await client.createDeployment({
      provider: 'spheron-ai',
      offerId: 'offer-1',
      gpuType: 'A4000_PCIE',
      gpuCount: 1,
      region: 'us-central-1',
      operatingSystem: 'Ubuntu 24.04 LTS (CUDA 13)',
      instanceType: 'DEDICATED',
      sshKeyId: 'key1',
      name: 'af-test-vm',
    })

    expect(result.id).toBe('6a012345')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('GET / DELETE — idempotent verbs DO retry on transient failures', () => {
  it('retries GET on AbortError', async () => {
    // First two calls reject with abort, third succeeds.
    let n = 0
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      n++
      if (n < 3) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      return Promise.resolve(mockResponse(200, [{ provider: 'spheron-ai' }]))
    })

    const client = makeClient({ timeoutMs: 20, maxRetries: 3 })
    const offers = await client.listProviders()
    expect(offers).toEqual([{ provider: 'spheron-ai' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries GET on 502 (5xx)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(mockResponse(200, []))

    const client = makeClient({ maxRetries: 3 })
    const result = await client.listProviders()
    expect(result).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries DELETE on AbortError', async () => {
    let n = 0
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      n++
      if (n < 2) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      return Promise.resolve(
        mockResponse(200, {
          message: 'ok',
          deployment: { id: 'x', status: 'terminated', stoppedAt: null },
        }),
      )
    })

    const client = makeClient({ timeoutMs: 20, maxRetries: 3 })
    const result = await client.deleteDeployment('x')
    expect(result.message).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('non-2xx error mapping', () => {
  it('surfaces a SpheronApiError carrying status + payload for 400s', async () => {
    fetchMock.mockResolvedValue(
      mockResponse(400, {
        error: 'Cannot terminate instance',
        message: 'Instance has already been terminated.',
        currentStatus: 'terminated',
        canTerminate: false,
      }),
    )

    const client = makeClient({ maxRetries: 3 })
    try {
      await client.deleteDeployment('x')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SpheronApiError)
      const apiErr = err as SpheronApiError
      expect(apiErr.status).toBe(400)
      expect(apiErr.isAlreadyGone()).toBe(true)
    }
    // 400 is non-retryable for any verb.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
