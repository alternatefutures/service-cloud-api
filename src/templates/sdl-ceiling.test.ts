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
import { infisicalServer } from './definitions/infisical.js'

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
    expect(resolveSdlPricingUact(true, undefined)).toBe(
      GPU_SDL_PRICING_CEILING_UACT
    )
    expect(resolveSdlPricingUact(true, 100)).toBe(GPU_SDL_PRICING_CEILING_UACT)
  })

  it('returns the template default for non-GPU deploys', () => {
    expect(resolveSdlPricingUact(false, 1500)).toBe(1500)
  })

  it('falls back to 1000 when template has no pricingUakt and no GPU', () => {
    expect(resolveSdlPricingUact(false, undefined)).toBe(
      NON_GPU_SDL_PRICING_CEILING_UACT
    )
    expect(resolveSdlPricingUact(false, 0)).toBe(
      NON_GPU_SDL_PRICING_CEILING_UACT
    )
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

describe('generateSDLFromTemplate — infisical customSdl', () => {
  it('produces a 3-service SDL with infisical, postgres, and redis', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).toContain('image: infisical/infisical:latest')
    expect(sdl).toContain('image: postgres:15-alpine')
    expect(sdl).toContain('image: redis:7-alpine')
  })

  it('substitutes ENCRYPTION_KEY and AUTH_SECRET from envOverrides', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).toContain('ENCRYPTION_KEY=aabbccddeeff00112233445566778899')
    expect(sdl).toContain('AUTH_SECRET=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0')
    expect(sdl).toContain('SMTP_PASSWORD=re_testkey123')
  })

  it('injects the same GENERATED_PASSWORD into DB_CONNECTION_URI and POSTGRES_PASSWORD', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    // Extract the generated password from POSTGRES_PASSWORD line
    const pgPwMatch = sdl.match(/- POSTGRES_PASSWORD=(\S+)/)
    expect(pgPwMatch).not.toBeNull()
    const generatedPw = pgPwMatch![1]
    // Same password must appear in DB_CONNECTION_URI
    expect(sdl).toContain(
      `DB_CONNECTION_URI=postgres://infisical:${generatedPw}@postgres:5432/infisical`
    )
    // No unreplaced placeholders
    expect(sdl).not.toContain('{{GENERATED_PASSWORD}}')
  })

  it('uses SITE_URL default when not overridden', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).toContain('SITE_URL=https://secrets.example.com')
  })

  it('respects SITE_URL override', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
        SITE_URL: 'https://secrets.alternatefutures.ai',
      },
    })
    expect(sdl).toContain('SITE_URL=https://secrets.alternatefutures.ai')
    expect(sdl).not.toContain('SITE_URL=https://secrets.example.com')
  })

  it('includes persistent storage for postgres with beta3 class', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).toContain('persistent: true')
    expect(sdl).toContain('class: beta3')
    expect(sdl).toContain('pg-data')
    expect(sdl).toContain('size: 10Gi')
  })

  it('has no unreplaced {{ENV.*}} placeholders', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).not.toMatch(/\{\{ENV\.[^}]+\}\}/)
  })

  it('emits per-service pricing summing to 55 uakt', () => {
    const sdl = generateSDLFromTemplate(infisicalServer, {
      envOverrides: {
        ENCRYPTION_KEY: 'aabbccddeeff00112233445566778899',
        AUTH_SECRET: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0',
        SMTP_PASSWORD: 're_testkey123',
      },
    })
    expect(sdl).toContain('amount: 20')
    expect(sdl).toContain('amount: 25')
    expect(sdl).toContain('amount: 10')
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
    expect(sdl).toContain(
      `gpu-svc:\n          denom: uact\n          amount: ${GPU_SDL_PRICING_CEILING_UACT}`
    )
    expect(sdl).toContain(
      `db-svc:\n          denom: uact\n          amount: 800`
    )
  })
})
