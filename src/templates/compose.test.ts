import { describe, it, expect } from 'vitest'
import {
  generateComposeFromTemplate,
  generateComposeFromService,
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
      'image: postgres:17-alpine'
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

describe('generateComposeFromService (raw service / non-template)', () => {
  const baseConfig = {
    dockerImage: 'ubuntu:24.04',
    ports: [{ containerPort: 80, publicPort: 80 }],
    envVars: [],
  }

  it('phala (default) mounts tappd.sock', () => {
    const yaml = generateComposeFromService(baseConfig)
    expect(yaml).toContain('/var/run/tappd.sock:/var/run/tappd.sock')
    expect(yaml).toContain('volumes:')
  })

  it('spheron drops tappd.sock mount entirely', () => {
    const yaml = generateComposeFromService({ ...baseConfig, target: 'spheron' })
    expect(yaml).not.toContain('tappd.sock')
    expect(yaml).not.toContain('volumes:')
  })

  it('spheron honours an explicit startCommand', () => {
    const yaml = generateComposeFromService({
      ...baseConfig,
      target: 'spheron',
      startCommand: 'sleep infinity',
    })
    expect(yaml).toContain('command: ["sh", "-c", "sleep infinity"]')
  })

  it('spheron without startCommand emits no command (caller must inject for VM flavor)', () => {
    const yaml = generateComposeFromService({ ...baseConfig, target: 'spheron' })
    expect(yaml).not.toContain('command:')
  })

  // ── Per-service-type smoke tests (Spheron) ─────────────────────────

  it('spheron VM (ubuntu:24.04) — sleep infinity, port 80, no volumes', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'ubuntu:24.04',
      ports: [],
      envVars: [],
      startCommand: 'sleep infinity',
      target: 'spheron',
    })
    expect(yaml).toContain('image: ubuntu:24.04')
    expect(yaml).toContain('command: ["sh", "-c", "sleep infinity"]')
    expect(yaml).toContain('"80:80"')
    expect(yaml).not.toContain('volumes:')
  })

  it('spheron DATABASE (postgres:17) — exposes containerPort, persists volume', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'postgres:17-alpine',
      ports: [],
      envVars: [
        { key: 'POSTGRES_PASSWORD', value: 's3cret' },
        { key: 'POSTGRES_DB', value: 'appdb' },
      ],
      containerPort: 5432,
      volumes: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data', size: '20Gi' }],
      target: 'spheron',
    })
    expect(yaml).toContain('image: postgres:17-alpine')
    expect(yaml).toContain('"5432:5432"')
    expect(yaml).not.toContain('"80:80"')
    expect(yaml).not.toContain('command:')
    expect(yaml).toContain('POSTGRES_PASSWORD=s3cret')
    expect(yaml).toContain('pgdata:/var/lib/postgresql/data')
    expect(yaml).toMatch(/^volumes:\n  pgdata: \{\}/m)
    expect(yaml).not.toContain('tappd.sock')
  })

  it('spheron SITE (github-built Next.js) — defaults to port 3000', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'ghcr.io/org/my-site:abc123',
      ports: [],
      envVars: [],
      isGithubBuild: true,
      target: 'spheron',
    })
    expect(yaml).toContain('"3000:3000"')
    expect(yaml).not.toContain('"80:80"')
    expect(yaml).not.toContain('command:')
  })

  it('spheron SITE (custom dockerImage, non-github) — defaults to 80', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'nginx:1.27',
      ports: [],
      envVars: [],
      target: 'spheron',
    })
    expect(yaml).toContain('"80:80"')
    expect(yaml).not.toContain('command:')
  })

  it('spheron — explicit ports row with publicPort wins over containerPort fallback', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'caddy:2',
      ports: [{ containerPort: 2019, publicPort: 8080 }],
      envVars: [],
      containerPort: 5432,
      isGithubBuild: true,
      target: 'spheron',
    })
    expect(yaml).toContain('"8080:2019"')
    expect(yaml).not.toContain('"5432')
    expect(yaml).not.toContain('"3000')
    expect(yaml).not.toContain('"80:80"')
  })

  it('spheron — multi-volume service emits all mounts and a top-level volumes block', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'mysql:8',
      ports: [],
      envVars: [{ key: 'MYSQL_ROOT_PASSWORD', value: 'rootpw' }],
      containerPort: 3306,
      volumes: [
        { name: 'data', mountPath: '/var/lib/mysql', size: '10Gi' },
        { name: 'logs', mountPath: '/var/log/mysql', size: '5Gi' },
      ],
      target: 'spheron',
    })
    expect(yaml).toContain('"3306:3306"')
    expect(yaml).toContain('data:/var/lib/mysql')
    expect(yaml).toContain('logs:/var/log/mysql')
    expect(yaml).toMatch(/^volumes:\n  data: \{\}\n  logs: \{\}/m)
  })

  it('phala raw — tappd mount AND named volumes coexist on the service', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'postgres:17-alpine',
      ports: [],
      envVars: [{ key: 'POSTGRES_PASSWORD', value: 'x' }],
      containerPort: 5432,
      volumes: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data', size: '20Gi' }],
      target: 'phala',
    })
    expect(yaml).toContain('/var/run/tappd.sock:/var/run/tappd.sock')
    expect(yaml).toContain('pgdata:/var/lib/postgresql/data')
    expect(yaml).toMatch(/^volumes:\n  pgdata: \{\}/m)
  })

  it('escapes shell metacharacters in env values and startCommand', () => {
    const yaml = generateComposeFromService({
      dockerImage: 'ubuntu:24.04',
      ports: [],
      envVars: [{ key: 'PASS', value: 'abc"def\\ghi' }],
      startCommand: 'echo "hi"',
      target: 'spheron',
    })
    expect(yaml).toContain('PASS=abc\\"def\\\\ghi')
    expect(yaml).toContain('command: ["sh", "-c", "echo \\"hi\\""]')
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
