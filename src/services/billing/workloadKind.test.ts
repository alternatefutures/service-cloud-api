import { describe, expect, it } from 'vitest'
import {
  getMinimumRuntimeFloorMinutes,
  getMinimumRuntimeFloorMs,
  MINIMUM_RUNTIME_FLOOR_MS,
} from '../../config/billing.js'
import {
  getAkashWorkloadKind,
  getPhalaWorkloadKind,
  getSpheronWorkloadKind,
} from './workloadKind.js'

describe('billing SOT — minimum runtime floor', () => {
  it('exposes a 20-minute GPU floor and a zero floor for cvm/cpu', () => {
    expect(MINIMUM_RUNTIME_FLOOR_MS.gpu).toBe(20 * 60_000)
    expect(MINIMUM_RUNTIME_FLOOR_MS.cvm).toBe(0)
    expect(MINIMUM_RUNTIME_FLOOR_MS.cpu).toBe(0)
  })

  it('helper conversions stay in sync (ms ↔ minutes)', () => {
    expect(getMinimumRuntimeFloorMs('gpu')).toBe(20 * 60_000)
    expect(getMinimumRuntimeFloorMinutes('gpu')).toBe(20)
    expect(getMinimumRuntimeFloorMinutes('cvm')).toBe(0)
    expect(getMinimumRuntimeFloorMinutes('cpu')).toBe(0)
  })
})

describe('workload-kind resolvers', () => {
  it('Spheron rows always resolve to gpu (Spheron sells GPU only)', () => {
    expect(getSpheronWorkloadKind()).toBe('gpu')
    expect(getSpheronWorkloadKind({ gpuCount: 0 })).toBe('gpu')
    expect(getSpheronWorkloadKind({ gpuCount: 8, gpuType: 'h100' })).toBe('gpu')
  })

  it('Phala resolves to gpu when gpuModel is set', () => {
    expect(getPhalaWorkloadKind({ gpuModel: 'h200', cvmSize: null })).toBe('gpu')
    expect(getPhalaWorkloadKind({ gpuModel: '   ', cvmSize: null })).toBe('cvm')
  })

  it('Phala falls back to GPU CVM size prefixes when gpuModel is null', () => {
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: 'h200.small' })).toBe('gpu')
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: 'H100.16xlarge' })).toBe('gpu')
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: 'b200.4xlarge' })).toBe('gpu')
  })

  it('Phala TDX-only sizes resolve to cvm', () => {
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: 'tdx.small' })).toBe('cvm')
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: 'tdx.4xlarge' })).toBe('cvm')
    expect(getPhalaWorkloadKind({ gpuModel: null, cvmSize: null })).toBe('cvm')
    expect(getPhalaWorkloadKind({ gpuModel: undefined, cvmSize: undefined })).toBe('cvm')
  })

  it('Akash resolves to gpu when gpuModel is populated post-lease', () => {
    expect(getAkashWorkloadKind({ gpuModel: 'h100' })).toBe('gpu')
    expect(getAkashWorkloadKind({ gpuModel: 'rtx4090' })).toBe('gpu')
  })

  it('Akash without a resolved gpuModel resolves to cpu', () => {
    expect(getAkashWorkloadKind({ gpuModel: null })).toBe('cpu')
    expect(getAkashWorkloadKind({ gpuModel: '' })).toBe('cpu')
    expect(getAkashWorkloadKind({ gpuModel: '   ' })).toBe('cpu')
    expect(getAkashWorkloadKind({})).toBe('cpu')
  })
})
