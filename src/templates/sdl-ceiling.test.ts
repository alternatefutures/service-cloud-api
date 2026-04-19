import { describe, expect, it } from 'vitest'

import {
  GPU_SDL_PRICING_CEILING_UACT,
  NON_GPU_SDL_PRICING_CEILING_UACT,
  generateCompositeSDL,
  generateSDLFromTemplate,
  resolveSdlPricingUact,
} from './sdl.js'
import type { ResolvedComponent } from './sdl.js'
import type { Template } from './schema.js'

const baseTemplate: Template = {
  id: 'gpu-test',
  name: 'GPU Test',
  description: 'fixture',
  category: 'AI_ML',
  tags: [],
  icon: '',
  repoUrl: '',
  dockerImage: 'ghcr.io/test/gpu:1',
  serviceType: 'VM',
  envVars: [],
  resources: {
    cpu: 1,
    memory: '1Gi',
    storage: '1Gi',
    gpu: { units: 1, vendor: 'nvidia', model: 'a100' },
  },
  ports: [{ port: 80, as: 80, global: true }],
  pricingUakt: 2000,
}

describe('resolveSdlPricingUact', () => {
  it('returns GPU_SDL_PRICING_CEILING_UACT for GPU deploys regardless of template default', () => {
    expect(resolveSdlPricingUact(true, 2000)).toBe(GPU_SDL_PRICING_CEILING_UACT)
    expect(resolveSdlPricingUact(true, undefined)).toBe(GPU_SDL_PRICING_CEILING_UACT)
    expect(resolveSdlPricingUact(true, 100)).toBe(GPU_SDL_PRICING_CEILING_UACT)
  })

  it('returns the template default for non-GPU deploys', () => {
    expect(resolveSdlPricingUact(false, 1500)).toBe(1500)
  })

  it('falls back to 1000 when template has no pricingUakt and no GPU', () => {
    expect(resolveSdlPricingUact(false, undefined)).toBe(NON_GPU_SDL_PRICING_CEILING_UACT)
    expect(resolveSdlPricingUact(false, 0)).toBe(NON_GPU_SDL_PRICING_CEILING_UACT)
  })
})

describe('generateSDLFromTemplate — pricing ceiling', () => {
  it('emits GPU_SDL_PRICING_CEILING_UACT for GPU templates regardless of template.pricingUakt', () => {
    const sdl = generateSDLFromTemplate(baseTemplate, { serviceName: 'svc' })
    expect(sdl).toContain(`amount: ${GPU_SDL_PRICING_CEILING_UACT}`)
    expect(sdl).not.toContain('amount: 2000')
  })

  it('respects template.pricingUakt when GPU is explicitly disabled via override', () => {
    const sdl = generateSDLFromTemplate(baseTemplate, {
      serviceName: 'svc',
      resourceOverrides: { gpu: null },
    })
    expect(sdl).toContain('amount: 2000')
    expect(sdl).not.toContain(`amount: ${GPU_SDL_PRICING_CEILING_UACT}`)
  })

  it('uses GPU ceiling when GPU is added via override on a non-GPU template', () => {
    const noGpuTemplate: Template = {
      ...baseTemplate,
      resources: { cpu: 1, memory: '1Gi', storage: '1Gi' },
      pricingUakt: 500,
    }
    const sdl = generateSDLFromTemplate(noGpuTemplate, {
      serviceName: 'svc',
      resourceOverrides: {
        gpu: { units: 1, vendor: 'nvidia', model: 'h200' },
      },
    })
    expect(sdl).toContain(`amount: ${GPU_SDL_PRICING_CEILING_UACT}`)
  })

  it('falls back to 1000 for plain non-GPU template with no pricingUakt', () => {
    const minimalTemplate: Template = {
      ...baseTemplate,
      resources: { cpu: 1, memory: '1Gi', storage: '1Gi' },
      pricingUakt: undefined,
    }
    const sdl = generateSDLFromTemplate(minimalTemplate, { serviceName: 'svc' })
    expect(sdl).toContain('amount: 1000')
  })
})

describe('generateCompositeSDL — per-component pricing ceiling', () => {
  it('uses GPU ceiling for GPU components and template pricing for non-GPU components', () => {
    const components: ResolvedComponent[] = [
      {
        id: 'gpu-svc',
        sdlServiceName: 'gpu-svc',
        dockerImage: 'ghcr.io/test/gpu:1',
        resources: {
          cpu: 1,
          memory: '1Gi',
          storage: '1Gi',
          gpu: { units: 1, vendor: 'nvidia', model: 'a100' },
        },
        ports: [{ port: 80, as: 80, global: true }],
        envVars: [],
        persistentStorage: [],
        pricingUakt: 2000,
        internalOnly: false,
        resolvedEnv: {},
      },
      {
        id: 'db-svc',
        sdlServiceName: 'db-svc',
        dockerImage: 'postgres:16',
        resources: { cpu: 1, memory: '512Mi', storage: '1Gi' },
        ports: [{ port: 5432, as: 5432, global: false }],
        envVars: [],
        persistentStorage: [],
        pricingUakt: 800,
        internalOnly: true,
        resolvedEnv: {},
      },
    ]
    const sdl = generateCompositeSDL(components)
    expect(sdl).toContain(`gpu-svc:\n          denom: uact\n          amount: ${GPU_SDL_PRICING_CEILING_UACT}`)
    expect(sdl).toContain(`db-svc:\n          denom: uact\n          amount: 800`)
  })
})
