import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildGhcrCredentialsBlock } from './orchestrator.js'

/**
 * `buildGhcrCredentialsBlock` is the only thing standing between a
 * private GHCR image and an `ImagePullBackOff` on every Akash provider
 * we deploy to. The exact YAML shape is dictated by the Akash SDL
 * "Private Container Registries" spec — see the comment in orchestrator.ts.
 *
 * We pin three things explicitly:
 *   1. Non-GHCR images get NO `credentials:` block (we don't leak our
 *      PAT to dockerhub.io or arbitrary registries).
 *   2. `GHCR_PULL_TOKEN` is preferred when set; `GHCR_PUSH_TOKEN` is the
 *      fallback. Mis-ordering this is a security regression because the
 *      push token has `write:packages`.
 *   3. The emitted block's `host:` includes the `https://` scheme. Akash
 *      providers silently ignore credentials when scheme is missing.
 */
describe('buildGhcrCredentialsBlock', () => {
  const originalPull = process.env.GHCR_PULL_TOKEN
  const originalPush = process.env.GHCR_PUSH_TOKEN

  beforeEach(() => {
    delete process.env.GHCR_PULL_TOKEN
    delete process.env.GHCR_PUSH_TOKEN
  })

  afterEach(() => {
    if (originalPull === undefined) delete process.env.GHCR_PULL_TOKEN
    else process.env.GHCR_PULL_TOKEN = originalPull
    if (originalPush === undefined) delete process.env.GHCR_PUSH_TOKEN
    else process.env.GHCR_PUSH_TOKEN = originalPush
  })

  it('returns empty for non-GHCR images, even with a token configured', () => {
    process.env.GHCR_PULL_TOKEN = 'ghp_anything'
    expect(buildGhcrCredentialsBlock('docker.io/library/nginx:latest')).toBe('')
    expect(buildGhcrCredentialsBlock('quay.io/foo/bar:1')).toBe('')
    expect(buildGhcrCredentialsBlock('registry.example.com/x:y')).toBe('')
  })

  it('returns empty for GHCR images when no tokens are configured', () => {
    expect(buildGhcrCredentialsBlock('ghcr.io/alternatefutures/x:1')).toBe('')
  })

  it('uses GHCR_PULL_TOKEN when present', () => {
    process.env.GHCR_PULL_TOKEN = 'ghp_pull_only_token'
    process.env.GHCR_PUSH_TOKEN = 'ghp_push_token_should_be_ignored'
    const out = buildGhcrCredentialsBlock('ghcr.io/alternatefutures/svc:abc')
    expect(out).toContain('password: ghp_pull_only_token')
    expect(out).not.toContain('ghp_push_token_should_be_ignored')
  })

  it('falls back to GHCR_PUSH_TOKEN when GHCR_PULL_TOKEN is absent', () => {
    process.env.GHCR_PUSH_TOKEN = 'ghp_push_token_fallback'
    const out = buildGhcrCredentialsBlock('ghcr.io/alternatefutures/svc:abc')
    expect(out).toContain('password: ghp_push_token_fallback')
  })

  it('emits the host with the https:// scheme (Akash spec compliance)', () => {
    process.env.GHCR_PULL_TOKEN = 'ghp_pull'
    const out = buildGhcrCredentialsBlock('ghcr.io/alternatefutures/svc:abc')
    expect(out).toContain('host: https://ghcr.io')
    // Sanity: no scheme-less variant slipped in
    expect(out).not.toMatch(/host:\s+ghcr\.io\b/)
  })

  it('uses a neutral username (does not leak the PAT owner identity)', () => {
    process.env.GHCR_PULL_TOKEN = 'ghp_pull'
    const out = buildGhcrCredentialsBlock('ghcr.io/alternatefutures/svc:abc')
    expect(out).toContain('username: af-deploy')
  })

  it('emits a properly indented `credentials:` block consumable by the SDL renderer', () => {
    process.env.GHCR_PULL_TOKEN = 'ghp_pull'
    const out = buildGhcrCredentialsBlock('ghcr.io/alternatefutures/svc:abc')
    // Block is intended to be prepended inside `services.<name>:` so the
    // four-space lead matters — anything else and the YAML parser will
    // either reject the SDL or silently mis-attribute the keys.
    expect(out.startsWith('    credentials:')).toBe(true)
    expect(out).toContain('      host: https://ghcr.io')
    expect(out).toContain('      username: af-deploy')
    expect(out).toContain('      password: ')
  })
})
