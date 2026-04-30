import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { generateSDLFromTemplate, buildPlacementAttributesBlock } from './sdl.js'
import type { Template } from './schema.js'

const baseTemplate: Template = {
  id: 'region-test',
  name: 'Region Test',
  description: 'fixture',
  category: 'AI_ML',
  tags: [],
  icon: '',
  repoUrl: '',
  dockerImage: 'nginx:1.27',
  serviceType: 'SITE',
  envVars: [],
  resources: { cpu: 1, memory: '1Gi', storage: '1Gi' },
  ports: [{ port: 80, as: 80, global: true }],
  pricingUakt: 1000,
}

describe('buildPlacementAttributesBlock', () => {
  beforeEach(() => {
    delete process.env.AF_REGIONS_SDL
  })

  it('returns empty string when region is null/undefined', () => {
    expect(buildPlacementAttributesBlock(null)).toBe('')
    expect(buildPlacementAttributesBlock(undefined)).toBe('')
    expect(buildPlacementAttributesBlock('')).toBe('')
  })

  it('emits the attributes YAML chunk when region is set', () => {
    const block = buildPlacementAttributesBlock('us-east')
    expect(block).toContain('attributes:')
    expect(block).toContain('region: us-east')
    expect(block.endsWith('\n')).toBe(true)
  })

  it('respects AF_REGIONS_SDL=0 kill switch', () => {
    process.env.AF_REGIONS_SDL = '0'
    expect(buildPlacementAttributesBlock('us-east')).toBe('')
  })

  it('emits when AF_REGIONS_SDL is unset (default ON)', () => {
    delete process.env.AF_REGIONS_SDL
    expect(buildPlacementAttributesBlock('eu')).toContain('region: eu')
  })

  it('emits when AF_REGIONS_SDL=1 (explicit ON)', () => {
    process.env.AF_REGIONS_SDL = '1'
    expect(buildPlacementAttributesBlock('asia')).toContain('region: asia')
  })

  afterEach(() => {
    delete process.env.AF_REGIONS_SDL
  })
})

describe('generateSDLFromTemplate — region emission', () => {
  beforeEach(() => {
    delete process.env.AF_REGIONS_SDL
  })

  it('does NOT emit attributes block when region is omitted (Any path)', () => {
    const sdl = generateSDLFromTemplate(baseTemplate, { serviceName: 'svc' })
    expect(sdl).not.toContain('attributes:')
    expect(sdl).not.toMatch(/region:\s+/)
  })

  it('emits attributes block under placement.dcloud when region is set', () => {
    const sdl = generateSDLFromTemplate(baseTemplate, {
      serviceName: 'svc',
      region: 'us-west',
    })
    expect(sdl).toContain('attributes:')
    expect(sdl).toContain('region: us-west')
    // The attributes chunk must come BEFORE signedBy/pricing per Akash SDL grammar.
    const attrIdx = sdl.indexOf('attributes:')
    const signedByIdx = sdl.indexOf('signedBy:')
    const pricingIdx = sdl.indexOf('pricing:')
    expect(attrIdx).toBeGreaterThan(0)
    expect(attrIdx).toBeLessThan(signedByIdx)
    expect(attrIdx).toBeLessThan(pricingIdx)
  })

  it('preserves SDL validity (correct indentation under dcloud)', () => {
    const sdl = generateSDLFromTemplate(baseTemplate, {
      serviceName: 'svc',
      region: 'eu',
    })
    // The `attributes:` key must be 6-space indented (sibling to signedBy/pricing).
    expect(sdl).toMatch(/\n {6}attributes:\n {8}region: eu\n/)
  })

  it('emits region with GPU template (placement block has no signedBy)', () => {
    const gpuTemplate: Template = {
      ...baseTemplate,
      resources: {
        ...baseTemplate.resources,
        gpu: { units: 1, vendor: 'nvidia', model: 'h100' },
      },
    }
    const sdl = generateSDLFromTemplate(gpuTemplate, {
      serviceName: 'svc',
      region: 'us-east',
    })
    expect(sdl).toContain('region: us-east')
    // GPU placements skip signedBy entirely, but still need attributes
    expect(sdl).not.toContain('signedBy:')
    expect(sdl).toContain('attributes:')
  })

  it('AF_REGIONS_SDL=0 disables emission even when region is set', () => {
    process.env.AF_REGIONS_SDL = '0'
    const sdl = generateSDLFromTemplate(baseTemplate, {
      serviceName: 'svc',
      region: 'us-east',
    })
    expect(sdl).not.toContain('attributes:')
    expect(sdl).not.toContain('region: us-east')
  })

  afterEach(() => {
    delete process.env.AF_REGIONS_SDL
  })
})
