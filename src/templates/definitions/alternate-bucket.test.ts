import { describe, it, expect } from 'vitest'
import { alternateBucket } from './alternate-bucket.js'
import { getTemplateById } from '../registry.js'
import { generateSDLFromTemplate } from '../sdl.js'
import { generateComposeFromTemplate } from '../compose.js'

describe('alternate-bucket template', () => {
  describe('registry registration', () => {
    it('is exposed by getTemplateById', () => {
      const fromRegistry = getTemplateById('alternate-bucket')
      expect(fromRegistry).toBeDefined()
      expect(fromRegistry).toBe(alternateBucket)
    })

    it('uses the STORAGE category', () => {
      expect(alternateBucket.category).toBe('STORAGE')
    })
  })

  describe('shape', () => {
    it('exposes both the console (9001 → 80) and S3 (9000 → 9000) ports', () => {
      const consolePort = alternateBucket.ports.find(p => p.port === 9001)
      const s3Port = alternateBucket.ports.find(p => p.port === 9000)

      expect(consolePort).toEqual({ port: 9001, as: 80, global: true })
      expect(s3Port).toEqual({ port: 9000, as: 9000, global: true })
    })

    it('mounts a persistent volume at /data', () => {
      expect(alternateBucket.persistentStorage).toBeDefined()
      const dataVol = alternateBucket.persistentStorage?.find(
        v => v.mountPath === '/data',
      )
      expect(dataVol).toBeDefined()
      expect(dataVol?.size).toMatch(/^\d+Gi$/)
    })

    it('chowns /data so the non-root run user can write to the volume', () => {
      expect(alternateBucket.akash?.chownPaths).toContain('/data')
      expect(alternateBucket.akash?.runUser).toBe('alternate-bucket')
      expect(alternateBucket.akash?.runUid).toBe(10001)
    })

    it('points at the brand-published image in our GHCR namespace', () => {
      expect(alternateBucket.dockerImage).toMatch(
        /^ghcr\.io\/alternatefutures\/alternate-bucket(:|$)/,
      )
    })
  })

  describe('environment variables', () => {
    it('only uses ALTERNATE_BUCKET_* keys (no RUSTFS_*)', () => {
      for (const v of alternateBucket.envVars) {
        expect(v.key.startsWith('ALTERNATE_BUCKET_')).toBe(true)
        expect(v.key).not.toMatch(/RUSTFS/i)
      }
    })

    it('marks the secret key as a secret with no default and platform-generated', () => {
      const secret = alternateBucket.envVars.find(
        v => v.key === 'ALTERNATE_BUCKET_SECRET_KEY',
      )
      expect(secret).toBeDefined()
      expect(secret?.required).toBe(true)
      expect(secret?.secret).toBe(true)
      expect(secret?.default).toBeNull()
      expect(secret?.platformInjected).toBe('generatedSecret')
    })

    it('marks the access key required and platform-generated (S3-style)', () => {
      const access = alternateBucket.envVars.find(
        v => v.key === 'ALTERNATE_BUCKET_ACCESS_KEY',
      )
      expect(access?.required).toBe(true)
      expect(access?.default).toBeNull()
      expect(access?.platformInjected).toBe('generatedAccessKey')
    })
  })

  describe('connection strings (S3 SDK linking)', () => {
    it('exposes AWS-compatible env keys for downstream services', () => {
      const cs = alternateBucket.connectionStrings
      expect(cs).toBeDefined()
      expect(cs?.AWS_ENDPOINT_URL_S3).toBeDefined()
      expect(cs?.S3_ENDPOINT).toBeDefined()
      expect(cs?.AWS_ACCESS_KEY_ID).toBeDefined()
      expect(cs?.AWS_SECRET_ACCESS_KEY).toBeDefined()
      expect(cs?.AWS_REGION).toBe('auto')
      expect(cs?.AWS_S3_FORCE_PATH_STYLE).toBe('true')
    })
  })

  describe('SDL generation (Akash)', () => {
    const sdl = generateSDLFromTemplate(alternateBucket)

    it('exposes both ports in the SDL', () => {
      expect(sdl).toContain('port: 9001')
      expect(sdl).toContain('as: 80')
      expect(sdl).toContain('port: 9000')
      expect(sdl).toContain('as: 9000')
    })

    it('declares the persistent volume mounted at /data', () => {
      expect(sdl).toContain('- name: data')
      expect(sdl).toContain('persistent: true')
      expect(sdl).toContain('mount: /data')
    })

    it('uses the brand image and not anything from the upstream namespace', () => {
      expect(sdl).toContain(
        'image: ghcr.io/alternatefutures/alternate-bucket:v2',
      )
      expect(sdl.toLowerCase()).not.toContain('rustfs')
    })
  })

  describe('Compose generation (Phala)', () => {
    const yaml = generateComposeFromTemplate(alternateBucket)

    it('exposes both ports in compose', () => {
      expect(yaml).toContain('"80:9001"')
      expect(yaml).toContain('"9000:9000"')
    })

    it('declares the data volume', () => {
      expect(yaml).toContain('data:/data')
    })

    it('uses the brand image and contains no upstream identifier', () => {
      expect(yaml).toContain(
        'image: ghcr.io/alternatefutures/alternate-bucket:v2',
      )
      expect(yaml.toLowerCase()).not.toContain('rustfs')
    })
  })

  describe('rebrand contract', () => {
    it('serialised template contains no upstream identifier (case-insensitive)', () => {
      const serialised = JSON.stringify(alternateBucket).toLowerCase()
      expect(serialised).not.toContain('rustfs')
    })
  })
})
