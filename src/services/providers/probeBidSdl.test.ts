import { describe, it, expect } from 'vitest'
import { buildProbeSdl, PROBE_PRICING_CEILING_UACT } from './probeBidSdl.js'

describe('buildProbeSdl', () => {
  it('builds a syntactically reasonable SDL for nvidia h100', () => {
    const sdl = buildProbeSdl('h100')
    expect(sdl).toContain('image: alpine:3')
    expect(sdl).toContain('cpu:')
    expect(sdl).toContain('units: 1')
    expect(sdl).toContain('memory:')
    expect(sdl).toContain('size: 256Mi')
    expect(sdl).toContain('gpu:')
    expect(sdl).toContain('vendor:')
    expect(sdl).toContain('nvidia:')
    expect(sdl).toContain('- model: h100')
    expect(sdl).toContain('denom: uact')
    expect(sdl).toContain(`amount: ${PROBE_PRICING_CEILING_UACT}`)
    expect(sdl).toContain('count: 1')
  })

  it('lower-cases the model token', () => {
    const sdl = buildProbeSdl('RTX4090')
    expect(sdl).toContain('- model: rtx4090')
    expect(sdl).not.toContain('RTX4090')
  })

  it('handles amd vendor + multi-token models like mi300x', () => {
    const sdl = buildProbeSdl('mi300x', 'amd')
    expect(sdl).toContain('amd:')
    expect(sdl).toContain('- model: mi300x')
    expect(sdl).not.toContain('nvidia:')
  })

  it.each([
    ['h100\nfoo: bar', 'newline injection'],
    ['h100 evil', 'space injection'],
    ['h100":"', 'quote injection'],
    ['h100; rm -rf /', 'shell metachar injection'],
    ['', 'empty model'],
    ['../h100', 'path traversal'],
    ['h100$VAR', 'env-expansion injection'],
  ])('rejects unsafe gpu model %j (%s)', input => {
    expect(() => buildProbeSdl(input)).toThrow(/Invalid gpu model token/)
  })

  it('rejects unsafe vendor', () => {
    expect(() => buildProbeSdl('h100', 'malicious' as never)).toThrow(/Invalid gpu vendor/)
  })

  it('uses the high pricing ceiling so honest providers can always bid', () => {
    // Sanity: a 100k uact ceiling per block at ~14k blocks/day is far above
    // any honest GPU price ($1.4k/day). If someone ever lowers this we
    // want a loud test failure to force the conversation.
    expect(PROBE_PRICING_CEILING_UACT).toBeGreaterThanOrEqual(100_000)
  })
})
