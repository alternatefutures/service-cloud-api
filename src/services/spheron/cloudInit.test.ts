/**
 * Pure-function tests for the Spheron cloud-init builder. No DB, no HTTP, no
 * mocks needed — locks down the contract that the orchestrator + the
 * `savedCloudInit` resume path both depend on.
 *
 * Why a dedicated test file (vs folding into `compose.test.ts`):
 *   - cloudInit is the single most security-sensitive surface in the Spheron
 *     integration: env-file mode 0600, .env newline rejection, port-allow
 *     ordering all come out of here. Folding into `compose.test.ts` buries
 *     the contract under template assertions.
 *   - The smart-pick-Docker heuristic is the place where Spheron-specific OS
 *     strings ("Ubuntu 22.04 + CUDA 13.0 Open + Docker") matter; the rest of
 *     the codebase has no business knowing about them.
 */

import { describe, expect, it } from 'vitest'

import {
  buildCloudInit,
  CloudInitValidationError,
  isDockerPreinstalled,
  renderEnvFile,
} from './cloudInit.js'

describe('isDockerPreinstalled', () => {
  it('returns true when the OS string mentions docker (any case)', () => {
    expect(isDockerPreinstalled('Ubuntu 22.04 + CUDA 13.0 Open + Docker')).toBe(true)
    expect(isDockerPreinstalled('ubuntu-22.04-docker')).toBe(true)
    expect(isDockerPreinstalled('Ubuntu 24.04 with DOCKER preinstalled')).toBe(true)
  })

  it('returns false for vanilla / custom images that omit docker', () => {
    expect(isDockerPreinstalled('Ubuntu 22.04')).toBe(false)
    expect(isDockerPreinstalled('ubuntu22.04_cuda12.8_shade_os')).toBe(false)
    expect(isDockerPreinstalled('ubuntu-22.04')).toBe(false)
  })

  it('uses a word boundary so unrelated tokens do not false-match', () => {
    // contrived but the regex IS \bdocker\b so this should be false.
    expect(isDockerPreinstalled('dockerless-debian')).toBe(false)
  })
})

describe('renderEnvFile', () => {
  it('returns empty string for empty / undefined input', () => {
    expect(renderEnvFile(undefined)).toBe('')
    expect(renderEnvFile({})).toBe('')
  })

  it('emits one KEY=value line per entry with a trailing newline', () => {
    expect(renderEnvFile({ A: '1', B: 'two' })).toBe('A=1\nB=two\n')
  })

  it('rejects keys that do not match the env-var grammar', () => {
    expect(() => renderEnvFile({ '1BAD': 'x' })).toThrow(CloudInitValidationError)
    expect(() => renderEnvFile({ 'has space': 'x' })).toThrow(CloudInitValidationError)
    expect(() => renderEnvFile({ 'has-dash': 'x' })).toThrow(CloudInitValidationError)
  })

  it('rejects values that contain a literal newline (LF or CR)', () => {
    expect(() => renderEnvFile({ K: 'line1\nline2' })).toThrow(/newline/)
    expect(() => renderEnvFile({ K: 'line1\rline2' })).toThrow(/newline/)
  })

  it('rejects non-string values', () => {
    expect(() => renderEnvFile({ K: 123 as unknown as string })).toThrow(/string/)
    expect(() => renderEnvFile({ K: null as unknown as string })).toThrow(/string/)
  })
})

describe('buildCloudInit', () => {
  const compose = 'services:\n  app:\n    image: nginx\n'

  it('emits apt install + systemctl + compose up for vanilla Ubuntu', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
    })
    expect(out.packages).toEqual(['docker.io', 'docker-compose-v2', 'ca-certificates'])
    expect(out.runcmd?.[0]).toBe('apt-get update -y')
    expect(out.runcmd?.[1]).toMatch(/apt-get install -y docker\.io docker-compose-v2 ca-certificates/)
    expect(out.runcmd).toContain('systemctl enable --now docker')
    expect(out.runcmd?.at(-1)).toBe('cd /opt/af && docker compose --env-file .env up -d')
  })

  it('skips apt install entirely when OS string indicates Docker is preinstalled', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04 + CUDA 13.0 Open + Docker',
    })
    expect(out.packages).toBeUndefined()
    expect(out.runcmd?.some(cmd => cmd.includes('apt-get install'))).toBe(false)
    // `systemctl enable --now docker` is still emitted — idempotent + cheap.
    expect(out.runcmd).toContain('systemctl enable --now docker')
    expect(out.runcmd?.at(-1)).toBe('cd /opt/af && docker compose --env-file .env up -d')
  })

  it('inlines compose + env writes via base64 in runcmd, never uses writeFiles', () => {
    // Spheron flattens writeFiles AFTER runcmd → bring-up runs before files
    // exist → set -e aborts. We avoid the trap by emitting NO writeFiles and
    // putting the file writes inside runcmd, ordered before the bring-up.
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
      envVars: { SECRET: 'shh' },
    })
    expect(out.writeFiles).toBeUndefined()

    const cmds = out.runcmd ?? []
    const mkdir = cmds.indexOf('mkdir -p /opt/af')
    const composeWrite = cmds.findIndex(c => c.includes('| base64 -d > /opt/af/docker-compose.yml'))
    const composeChmod = cmds.indexOf('chmod 0644 /opt/af/docker-compose.yml')
    const envWrite = cmds.findIndex(c => c.includes('| base64 -d > /opt/af/.env'))
    const envChmod = cmds.indexOf('chmod 0600 /opt/af/.env')
    const composeUp = cmds.indexOf('cd /opt/af && docker compose --env-file .env up -d')

    expect(mkdir).toBeGreaterThanOrEqual(0)
    expect(composeWrite).toBeGreaterThan(mkdir)
    expect(composeChmod).toBeGreaterThan(composeWrite)
    expect(envWrite).toBeGreaterThan(composeWrite)
    expect(envChmod).toBeGreaterThan(envWrite)
    expect(composeUp).toBeGreaterThan(envChmod)

    // Roundtrip the base64 to prove the actual file bodies match what the
    // caller asked for — including secrets in the .env.
    const composeB64 = cmds[composeWrite].split(' ')[1]
    const envB64 = cmds[envWrite].split(' ')[1]
    expect(Buffer.from(composeB64, 'base64').toString('utf8')).toBe(compose)
    expect(Buffer.from(envB64, 'base64').toString('utf8')).toBe('SECRET=shh\n')
  })

  it('lays down an empty .env file even when no envVars are provided', () => {
    // docker-compose's `--env-file .env` ENOENTs if the file is missing.
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
    })
    const cmds = out.runcmd ?? []
    const envWrite = cmds.find(c => c.includes('| base64 -d > /opt/af/.env'))
    expect(envWrite).toBeDefined()
    const b64 = envWrite!.split(' ')[1]
    // Base64 of empty string is empty string.
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('')
  })

  it('omits compose-up entirely when composeContent is empty', () => {
    const out = buildCloudInit({
      composeContent: '',
      operatingSystem: 'Ubuntu 22.04',
    })
    expect(out.writeFiles).toBeUndefined()
    expect(out.runcmd?.some(cmd => cmd.includes('docker compose'))).toBe(false)
    expect(out.runcmd?.some(cmd => cmd.includes('/opt/af'))).toBe(false)
    // Docker is still installed as a courtesy so the user can `docker run` themselves.
    expect(out.runcmd).toContain('systemctl enable --now docker')
  })

  it('opens UFW for each exposePorts entry BEFORE compose-up (race fix)', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
      exposePorts: [3000, 8080],
    })
    const cmds = out.runcmd ?? []
    const ufw3000 = cmds.indexOf('ufw allow 3000/tcp || true')
    const ufw8080 = cmds.indexOf('ufw allow 8080/tcp || true')
    const composeUp = cmds.indexOf('cd /opt/af && docker compose --env-file .env up -d')
    expect(ufw3000).toBeGreaterThanOrEqual(0)
    expect(ufw8080).toBeGreaterThanOrEqual(0)
    expect(ufw3000).toBeLessThan(composeUp)
    expect(ufw8080).toBeLessThan(composeUp)
  })

  it('uses `|| true` so a missing UFW does not fail the boot', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'sesterce-ubuntu22.04', // shade_os doesn't ship UFW
      exposePorts: [3000],
    })
    expect(out.runcmd?.some(cmd => /ufw allow 3000\/tcp \|\| true/.test(cmd))).toBe(true)
  })

  it('rejects out-of-range and non-integer exposePorts entries', () => {
    expect(() =>
      buildCloudInit({
        composeContent: compose,
        operatingSystem: 'Ubuntu 22.04',
        exposePorts: [0],
      }),
    ).toThrow(CloudInitValidationError)
    expect(() =>
      buildCloudInit({
        composeContent: compose,
        operatingSystem: 'Ubuntu 22.04',
        exposePorts: [70000],
      }),
    ).toThrow(CloudInitValidationError)
    expect(() =>
      buildCloudInit({
        composeContent: compose,
        operatingSystem: 'Ubuntu 22.04',
        exposePorts: [3.14 as unknown as number],
      }),
    ).toThrow(CloudInitValidationError)
  })

  it('appends extraRuncmd lines AFTER compose-up so they run against a live stack', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
      extraRuncmd: ['echo done > /tmp/af-ready'],
    })
    const cmds = out.runcmd ?? []
    const composeUp = cmds.indexOf('cd /opt/af && docker compose --env-file .env up -d')
    const extra = cmds.indexOf('echo done > /tmp/af-ready')
    expect(extra).toBeGreaterThan(composeUp)
  })

  it('drops empty / non-string extraRuncmd entries silently (callers shouldnt have to filter)', () => {
    const out = buildCloudInit({
      composeContent: compose,
      operatingSystem: 'Ubuntu 22.04',
      extraRuncmd: ['real cmd', '', null as unknown as string, undefined as unknown as string],
    })
    expect(out.runcmd?.includes('real cmd')).toBe(true)
    expect(out.runcmd?.some(c => c === '')).toBe(false)
  })

  it('returns a minimal payload (no empty arrays) for diff stability', () => {
    const out = buildCloudInit({
      composeContent: '',
      operatingSystem: 'Ubuntu 22.04 with Docker',
    })
    // No compose → no writeFiles. preinstalled → no packages. Only runcmd.
    expect(out.packages).toBeUndefined()
    expect(out.writeFiles).toBeUndefined()
    expect(out.runcmd).toBeDefined()
  })
})
