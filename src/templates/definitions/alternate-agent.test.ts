import { describe, it, expect } from 'vitest'
import { alternateAgent } from './alternate-agent.js'
import { getTemplateById } from '../registry.js'

describe('alternate-agent template', () => {
  describe('registry', () => {
    it('is exposed by getTemplateById', () => {
      const fromRegistry = getTemplateById('alternate-agent')
      expect(fromRegistry).toBeDefined()
      expect(fromRegistry).toBe(alternateAgent)
    })

    it('is in the AI_ML category and featured', () => {
      expect(alternateAgent.category).toBe('AI_ML')
      expect(alternateAgent.featured).toBe(true)
    })

    it('has graduated out of internal release stage', () => {
      // Public template — no releaseStage, or explicitly not "internal".
      expect(alternateAgent.releaseStage ?? 'public').not.toBe('internal')
    })

    it('points at the v2 image (X/Supabase/autonomous-loop revision)', () => {
      expect(alternateAgent.dockerImage).toBe(
        'ghcr.io/alternatefutures/alternate-agent:v2',
      )
    })

    it('is tagged so the catalog can discover it via `x`, `social`, `rag`, `autonomous`', () => {
      for (const tag of ['x', 'twitter', 'social', 'rag', 'supabase', 'autonomous']) {
        expect(alternateAgent.tags).toContain(tag)
      }
    })
  })

  describe('environment variables', () => {
    const envByKey = (key: string) =>
      alternateAgent.envVars.find((v) => v.key === key)

    it('platform-injects AF_API_KEY (the AF PAT used for chat + image + video billing)', () => {
      const v = envByKey('AF_API_KEY')
      expect(v?.required).toBe(true)
      expect(v?.secret).toBe(true)
      expect(v?.platformInjected).toBe('apiKey')
    })

    it('platform-injects AF_ORG_ID', () => {
      const v = envByKey('AF_ORG_ID')
      expect(v?.required).toBe(true)
      expect(v?.platformInjected).toBe('orgId')
    })

    it('exposes AGENT_GOAL as the autonomous-mode trigger', () => {
      const v = envByKey('AGENT_GOAL')
      expect(v).toBeDefined()
      expect(v?.required).toBe(false) // autonomous mode is opt-in
    })

    it('exposes AUTONOMOUS_INTERVAL_MIN with a sane default', () => {
      const v = envByKey('AUTONOMOUS_INTERVAL_MIN')
      expect(v).toBeDefined()
      expect(v?.default).toBe('30')
    })

    it('exposes Supabase RAG envs (URL, key, RPC name) — all optional', () => {
      expect(envByKey('SUPABASE_URL')).toBeDefined()
      expect(envByKey('SUPABASE_URL')?.required).toBe(false)

      const key = envByKey('SUPABASE_KEY')
      expect(key).toBeDefined()
      expect(key?.required).toBe(false)
      expect(key?.secret).toBe(true)

      const rpc = envByKey('SUPABASE_RPC_NAME')
      expect(rpc?.default).toBe('match_documents')
    })

    it('exposes both X auth paths: TWITTER_COOKIES (recommended) AND TWITTER_USERNAME/PASSWORD/EMAIL (fallback)', () => {
      const cookies = envByKey('TWITTER_COOKIES')
      expect(cookies).toBeDefined()
      expect(cookies?.secret).toBe(true)

      expect(envByKey('TWITTER_USERNAME')).toBeDefined()
      expect(envByKey('TWITTER_PASSWORD')?.secret).toBe(true)
      expect(envByKey('TWITTER_EMAIL')).toBeDefined()
    })

    it('exposes media-gen model overrides with conservative cost-aware defaults', () => {
      const img = envByKey('IMAGE_GEN_MODEL')
      expect(img?.default).toBe('fal-ai/flux/schnell') // ~$0.003/image, the cheap-and-fast default
      const vid = envByKey('VIDEO_GEN_MODEL')
      expect(vid).toBeDefined()
      // Don't assert exact model — fal.ai's video catalog churns; just assert
      // it points at fal-ai (routed through AF proxy).
      expect(vid?.default).toMatch(/^fal-ai\//)
    })

    it('keeps Discord connector available', () => {
      const v = envByKey('DISCORD_BOT_TOKEN')
      expect(v).toBeDefined()
      expect(v?.secret).toBe(true)
    })
  })

  describe('persistence + permissions', () => {
    it('mounts a persistent volume at /app/data so the X session cookies and Mastra cache survive restarts', () => {
      const data = alternateAgent.persistentStorage?.find(
        (v) => v.mountPath === '/app/data',
      )
      expect(data).toBeDefined()
      expect(data?.size).toMatch(/^\d+Gi$/)
    })

    it('chowns /app/data on Akash so the node user can write the session cache', () => {
      expect(alternateAgent.akash?.chownPaths).toContain('/app/data')
      expect(alternateAgent.akash?.runUser).toBe('node')
      expect(alternateAgent.akash?.runUid).toBe(1000)
    })
  })

  describe('composite topology', () => {
    it('keeps the bundled pgvector companion for Mastra working memory + semantic recall', () => {
      const db = alternateAgent.components?.find((c) => c.id === 'db')
      expect(db).toBeDefined()
      expect(db?.internalOnly).toBe(true)
      expect(db?.inline?.dockerImage).toBe('pgvector/pgvector:pg17')
    })

    it('wires DATABASE_URL on the agent component via envLinks (cross-component link)', () => {
      const agent = alternateAgent.components?.find((c) => c.id === 'agent')
      expect(agent?.primary).toBe(true)
      expect(agent?.envLinks?.DATABASE_URL).toContain('{{component.db.host}}')
      expect(agent?.envLinks?.DATABASE_URL).toContain('{{generated.password}}')
    })
  })
})
