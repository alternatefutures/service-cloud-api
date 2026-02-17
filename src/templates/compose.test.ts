import { describe, it, expect } from 'vitest'
import {
  generateComposeFromTemplate,
  getEnvKeysFromTemplate,
} from './compose.js'
import { postgres } from './definitions/postgres.js'
import { nanobotGateway } from './definitions/nanobot-gateway.js'
import type { Template } from './schema.js'

describe('generateComposeFromTemplate', () => {
  it('produces valid compose structure with services.app', () => {
    const yaml = generateComposeFromTemplate(postgres)
    expect(yaml).toContain('services:')
    expect(yaml).toContain('  app:')
    expect(yaml).toContain('    image:')
  })

  it('uses template docker image', () => {
    expect(generateComposeFromTemplate(postgres)).toContain(
      'image: postgres:16-alpine'
    )
    expect(generateComposeFromTemplate(nanobotGateway)).toContain(
      'image: ghcr.io/alternatefutures/nanobot-akash:v2'
    )
  })

  it('maps ports as external:internal', () => {
    expect(generateComposeFromTemplate(postgres)).toContain('"5432:5432"')
    expect(generateComposeFromTemplate(nanobotGateway)).toContain('"80:18790"')
  })

  it('includes TEE socket mount', () => {
    const yaml = generateComposeFromTemplate(postgres)
    expect(yaml).toContain('/var/run/tappd.sock:/var/run/tappd.sock')
  })

  it('includes template default env vars', () => {
    const yaml = generateComposeFromTemplate(postgres)
    expect(yaml).toContain('POSTGRES_DB=appdb')
    expect(yaml).toContain('POSTGRES_USER=postgres')
    expect(yaml).toContain('PGDATA=')
  })

  it('merges env overrides', () => {
    const yaml = generateComposeFromTemplate(postgres, {
      envOverrides: { POSTGRES_PASSWORD: 'secret123' },
    })
    expect(yaml).toContain('POSTGRES_PASSWORD=secret123')
  })

  it('adds persistent storage volumes', () => {
    const yaml = generateComposeFromTemplate(postgres)
    expect(yaml).toContain('pgdata:/var/lib/postgresql/data')
    expect(yaml).toContain('volumes:')
    expect(yaml).toContain('  pgdata:')
  })

  it('adds startCommand when present', () => {
    const templateWithCommand: Template = {
      ...postgres,
      startCommand: 'echo hello',
    }
    const yaml = generateComposeFromTemplate(templateWithCommand)
    expect(yaml).toContain('command:')
    expect(yaml).toContain('sh')
    expect(yaml).toContain('-c')
  })

  it('handles template with no env defaults', () => {
    const minimal: Template = {
      ...postgres,
      envVars: [],
    }
    const yaml = generateComposeFromTemplate(minimal)
    expect(yaml).toContain('services:')
    expect(yaml).toContain('  app:')
  })
})

describe('getEnvKeysFromTemplate', () => {
  it('returns template env var keys', () => {
    const keys = getEnvKeysFromTemplate(postgres)
    expect(keys).toContain('POSTGRES_DB')
    expect(keys).toContain('POSTGRES_USER')
    expect(keys).toContain('POSTGRES_PASSWORD')
    expect(keys).toContain('PGDATA')
  })

  it('includes override keys', () => {
    const keys = getEnvKeysFromTemplate(postgres, {
      POSTGRES_PASSWORD: 'x',
      CUSTOM_VAR: 'y',
    })
    expect(keys).toContain('POSTGRES_PASSWORD')
    expect(keys).toContain('CUSTOM_VAR')
  })

  it('returns unique keys', () => {
    const keys = getEnvKeysFromTemplate(postgres, {
      POSTGRES_DB: 'overridden',
    })
    const set = new Set(keys)
    expect(keys.length).toBe(set.size)
  })

  it('never includes values', () => {
    const keys = getEnvKeysFromTemplate(postgres, {
      POSTGRES_PASSWORD: 'super-secret',
    })
    expect(keys.every(k => typeof k === 'string')).toBe(true)
    expect(keys).not.toContain('super-secret')
  })
})
