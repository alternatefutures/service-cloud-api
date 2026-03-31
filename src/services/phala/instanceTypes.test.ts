import { beforeEach, describe, expect, it, vi } from 'vitest'

const execAsyncMock = vi.fn()

vi.mock('../queue/asyncExec.js', () => ({
  execAsync: execAsyncMock,
}))

const GPU_CATALOG = JSON.stringify({
  success: true,
  result: [
    {
      name: 'gpu',
      items: [
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
          id: 'h100.small',
          name: 'H100',
          vcpu: 16,
          memory_mb: 131072,
          hourly_rate: '2.800000',
          requires_gpu: true,
          family: 'gpu',
        },
      ],
    },
    {
      name: 'cpu',
      items: [
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
      ],
    },
  ],
})

describe('resolvePhalaInstanceType', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.PHALA_API_KEY = 'phak_test_key'
  })

  it('selects the smallest CPU instance satisfying requested resources', async () => {
    execAsyncMock.mockResolvedValue(GPU_CATALOG)

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')
    const result = await resolvePhalaInstanceType({
      cpu: 2,
      memory: '4Gi',
      storage: '20Gi',
    })

    expect(result).toEqual({
      cvmSize: 'tdx.medium',
      gpuModel: null,
      gpuCount: 0,
      hourlyRateUsd: 0.116,
    })
  })

  it('selects a matching GPU instance type for the requested model', async () => {
    execAsyncMock.mockResolvedValue(GPU_CATALOG)

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')
    const result = await resolvePhalaInstanceType({
      cpu: 1,
      memory: '2Gi',
      storage: '20Gi',
      gpu: { units: 1, vendor: 'nvidia', model: 'h200' },
    })

    expect(result).toEqual({
      cvmSize: 'h200.small',
      gpuModel: 'h200',
      gpuCount: 1,
      hourlyRateUsd: 3.5,
    })
  })

  it('filters GPU instances by unit count', async () => {
    execAsyncMock.mockResolvedValue(GPU_CATALOG)

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')
    const result = await resolvePhalaInstanceType({
      cpu: 1,
      memory: '2Gi',
      storage: '20Gi',
      gpu: { units: 8, vendor: 'nvidia', model: 'h200' },
    })

    expect(result.cvmSize).toBe('h200.8x.large')
    expect(result.gpuCount).toBe(8)
  })

  it('throws when requested GPU unit count exceeds available', async () => {
    execAsyncMock.mockResolvedValue(GPU_CATALOG)

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')

    await expect(
      resolvePhalaInstanceType({
        cpu: 1,
        memory: '2Gi',
        storage: '20Gi',
        gpu: { units: 16, vendor: 'nvidia', model: 'h200' },
      })
    ).rejects.toThrow('No Phala GPU instance matches')
  })

  it('throws when the requested GPU model is unavailable', async () => {
    execAsyncMock.mockResolvedValue(GPU_CATALOG)

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')

    await expect(
      resolvePhalaInstanceType({
        cpu: 1,
        memory: '2Gi',
        storage: '20Gi',
        gpu: { units: 1, vendor: 'nvidia', model: 'b200' },
      })
    ).rejects.toThrow('No Phala GPU instance matches')
  })

  it('falls back to hardcoded catalog when CLI fails', async () => {
    execAsyncMock.mockRejectedValue(new Error('CLI timeout'))

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')
    const result = await resolvePhalaInstanceType({
      cpu: 1,
      memory: '2Gi',
      storage: '20Gi',
    })

    expect(result.cvmSize).toBe('tdx.small')
    expect(result.gpuModel).toBeNull()
  })

  it('falls back to hardcoded catalog when CLI returns empty', async () => {
    execAsyncMock.mockResolvedValue(JSON.stringify({ success: true, result: [] }))

    const { resolvePhalaInstanceType } = await import('./instanceTypes.js')
    const result = await resolvePhalaInstanceType({
      cpu: 4,
      memory: '8Gi',
      storage: '20Gi',
    })

    expect(result.cvmSize).toBe('tdx.large')
  })
})

describe('inferGpuCountFromId', () => {
  it('returns 1 for single-GPU instance types', async () => {
    const { inferGpuCountFromId } = await import('./instanceTypes.js')
    expect(inferGpuCountFromId('h200.small')).toBe(1)
    expect(inferGpuCountFromId('h100.small')).toBe(1)
    expect(inferGpuCountFromId('b200.small')).toBe(1)
  })

  it('extracts multiplier from multi-GPU instance types', async () => {
    const { inferGpuCountFromId } = await import('./instanceTypes.js')
    expect(inferGpuCountFromId('h200.8x.large')).toBe(8)
    expect(inferGpuCountFromId('h100.4x.medium')).toBe(4)
  })
})

describe('parseMemoryToMb', () => {
  it('converts binary units correctly', async () => {
    const { parseMemoryToMb } = await import('./instanceTypes.js')
    expect(parseMemoryToMb('1Gi')).toBe(1024)
    expect(parseMemoryToMb('4Gi')).toBe(4096)
    expect(parseMemoryToMb('512Mi')).toBe(512)
  })

  it('throws on invalid input', async () => {
    const { parseMemoryToMb } = await import('./instanceTypes.js')
    expect(() => parseMemoryToMb('abc')).toThrow('Unsupported memory value')
  })
})
