import { describe, it, expect } from 'vitest'
import { rustfs } from './rustfs.js'
import { getTemplateById } from '../registry.js'
import { generateSDLFromTemplate } from '../sdl.js'
import { generateComposeFromTemplate } from '../compose.js'

describe('rustfs template', () => {
  describe('registry registration', () => {
    it('is exposed by getTemplateById', () => {
      const fromRegistry = getTemplateById('rustfs')
      expect(fromRegistry).toBeDefined()
      expect(fromRegistry).toBe(rustfs)
    })

    it('uses the STORAGE category', () => {
      expect(rustfs.category).toBe('STORAGE')
    })

    it('is tagged "decentralized" so the catalog can filter it into the Decentralized section', () => {
      expect(rustfs.tags).toContain('decentralized')
    })

    it('declares serviceType=BUCKET so it shows up as a first-class bucket service', () => {
      expect(rustfs.serviceType).toBe('BUCKET')
    })
  })

  describe('shape', () => {
    it('exposes both the console (9001 → 80) and S3 (9000 → 9000) ports', () => {
      const consolePort = rustfs.ports.find(p => p.port === 9001)
      const s3Port = rustfs.ports.find(p => p.port === 9000)

      expect(consolePort).toEqual({ port: 9001, as: 80, global: true })
      expect(s3Port).toEqual({ port: 9000, as: 9000, global: true })
    })

    it('mounts a persistent volume at /data', () => {
      expect(rustfs.persistentStorage).toBeDefined()
      const dataVol = rustfs.persistentStorage?.find(
        v => v.mountPath === '/data',
      )
      expect(dataVol).toBeDefined()
      expect(dataVol?.size).toMatch(/^\d+Gi$/)
    })

    it('chowns /data and /logs so the rustfs user can write to the volumes', () => {
      expect(rustfs.akash?.chownPaths).toContain('/data')
      expect(rustfs.akash?.chownPaths).toContain('/logs')
      expect(rustfs.akash?.runUser).toBe('rustfs')
      expect(rustfs.akash?.runUid).toBe(10001)
    })

    it('points at the AF-published thin-fork image in our GHCR namespace', () => {
      expect(rustfs.dockerImage).toMatch(
        /^ghcr\.io\/alternatefutures\/rustfs(:|$)/,
      )
    })
  })

  describe('environment variables', () => {
    it('only uses upstream RUSTFS_* keys (no rebrand prefix)', () => {
      for (const v of rustfs.envVars) {
        expect(v.key.startsWith('RUSTFS_')).toBe(true)
        expect(v.key).not.toMatch(/ALTERNATE_BUCKET/i)
      }
    })

    it('marks the secret key as a secret with no default and platform-generated', () => {
      const secret = rustfs.envVars.find(v => v.key === 'RUSTFS_SECRET_KEY')
      expect(secret).toBeDefined()
      expect(secret?.required).toBe(true)
      expect(secret?.secret).toBe(true)
      expect(secret?.default).toBeNull()
      expect(secret?.platformInjected).toBe('generatedSecret')
    })

    it('marks the access key required and platform-generated (S3-style)', () => {
      const access = rustfs.envVars.find(v => v.key === 'RUSTFS_ACCESS_KEY')
      expect(access?.required).toBe(true)
      expect(access?.default).toBeNull()
      expect(access?.platformInjected).toBe('generatedAccessKey')
    })
  })

  describe('connection strings (S3 SDK linking)', () => {
    it('exposes AWS-compatible env keys for downstream services', () => {
      const cs = rustfs.connectionStrings
      expect(cs).toBeDefined()
      expect(cs?.AWS_ENDPOINT_URL_S3).toBeDefined()
      expect(cs?.S3_ENDPOINT).toBeDefined()
      expect(cs?.AWS_ACCESS_KEY_ID).toBe('{{env.RUSTFS_ACCESS_KEY}}')
      expect(cs?.AWS_SECRET_ACCESS_KEY).toBe('{{env.RUSTFS_SECRET_KEY}}')
      expect(cs?.AWS_REGION).toBe('auto')
      expect(cs?.AWS_S3_FORCE_PATH_STYLE).toBe('true')
    })
  })

  describe('SDL generation (Akash)', () => {
    const sdl = generateSDLFromTemplate(rustfs)

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

    it('uses the AF thin-fork image (which wraps upstream rustfs)', () => {
      expect(sdl).toContain(
        'image: ghcr.io/alternatefutures/rustfs:1.0.0-beta.1',
      )
    })

    it('injects AKASH_CHOWN_PATHS for /data and /logs so the entrypoint can fix volume ownership', () => {
      expect(sdl).toContain('AKASH_CHOWN_PATHS=/data:/logs')
      expect(sdl).toContain('AKASH_RUN_USER=rustfs')
      expect(sdl).toContain('AKASH_RUN_UID=10001')
    })
  })

  describe('Compose generation (Phala)', () => {
    const yaml = generateComposeFromTemplate(rustfs)

    it('exposes both ports in compose', () => {
      expect(yaml).toContain('"80:9001"')
      expect(yaml).toContain('"9000:9000"')
    })

    it('declares the data volume', () => {
      expect(yaml).toContain('data:/data')
    })

    it('uses the AF thin-fork image', () => {
      expect(yaml).toContain(
        'image: ghcr.io/alternatefutures/rustfs:1.0.0-beta.1',
      )
    })
  })
})
