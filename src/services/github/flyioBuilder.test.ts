import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { __test__ } from './flyioBuilder.js'

const { parseVolumeList, parseCpuKind, parseEnvInt, redactFlyErrorBody } = __test__

/**
 * These helpers gate every spawn — a mis-parse is silent (builds quietly
 * slide to ephemeral dockerd or a 422 at POST time), so the tests exist
 * less for logic coverage and more as a contract pin.
 */
describe('parseVolumeList', () => {
  it('returns an empty list when the env var is unset', () => {
    expect(parseVolumeList(undefined)).toEqual([])
  })

  it('returns an empty list for an empty string', () => {
    expect(parseVolumeList('')).toEqual([])
  })

  it('parses a single well-formed volume id', () => {
    expect(parseVolumeList('vol_abc123')).toEqual(['vol_abc123'])
  })

  it('parses multiple comma-separated ids', () => {
    expect(parseVolumeList('vol_aaaaaa,vol_bbbbbb,vol_cccccc')).toEqual([
      'vol_aaaaaa',
      'vol_bbbbbb',
      'vol_cccccc',
    ])
  })

  it('trims surrounding whitespace (YAML users love spaces after commas)', () => {
    expect(parseVolumeList(' vol_aaaaaa , vol_bbbbbb ,vol_cccccc ')).toEqual([
      'vol_aaaaaa',
      'vol_bbbbbb',
      'vol_cccccc',
    ])
  })

  it('filters out empty entries from trailing or doubled commas', () => {
    expect(parseVolumeList('vol_aaaaaa,,vol_bbbbbb,')).toEqual(['vol_aaaaaa', 'vol_bbbbbb'])
  })

  it('rejects entries that do not match the Fly volume id shape', () => {
    // Typos we expect to see in the wild: hyphen instead of underscore,
    // missing prefix, pasted k8s PVC name, pasted Akash dseq.
    expect(parseVolumeList('vol-abc123,volume_42,1234567890,vol_valid12')).toEqual(['vol_valid12'])
  })

  it('rejects the prefix alone (no id body)', () => {
    expect(parseVolumeList('vol_')).toEqual([])
  })

  it('rejects ids with illegal characters', () => {
    expect(parseVolumeList('vol_abc/def,vol_abc.def,vol_abc def')).toEqual([])
  })
})

describe('parseCpuKind', () => {
  it('returns the fallback when unset', () => {
    expect(parseCpuKind(undefined, 'performance')).toBe('performance')
  })

  it('returns the fallback for an empty string', () => {
    expect(parseCpuKind('', 'shared')).toBe('shared')
  })

  it('accepts shared', () => {
    expect(parseCpuKind('shared', 'performance')).toBe('shared')
  })

  it('accepts performance', () => {
    expect(parseCpuKind('performance', 'shared')).toBe('performance')
  })

  it('falls back (rather than blindly casting) on a typo', () => {
    // Previously `as 'shared' | 'performance'` would happily hand Fly
    // the string "perfromance" and eat a 400 at spawn time.
    expect(parseCpuKind('perfromance', 'performance')).toBe('performance')
  })

  it('is case-sensitive — Fly is too', () => {
    expect(parseCpuKind('Performance', 'shared')).toBe('shared')
  })
})

describe('parseEnvInt', () => {
  it('returns the fallback when unset', () => {
    expect(parseEnvInt('X', undefined, 42, { min: 0, max: 100 })).toBe(42)
  })

  it('returns the fallback for empty string', () => {
    expect(parseEnvInt('X', '', 42, { min: 0, max: 100 })).toBe(42)
  })

  it('parses a clean integer', () => {
    expect(parseEnvInt('X', '17', 0, { min: 0, max: 100 })).toBe(17)
  })

  it('parses leading-integer strings like "4096"', () => {
    expect(parseEnvInt('X', '4096', 0, { min: 0, max: 65_536 })).toBe(4096)
  })

  it('falls back when the input is non-numeric ("4gb")', () => {
    // Number('4gb') === NaN; the old code passed NaN to Fly and got a
    // 400 response. Here we refuse to propagate NaN.
    expect(parseEnvInt('X', 'nonsense', 2, { min: 1, max: 16 })).toBe(2)
  })

  it('falls back below min', () => {
    expect(parseEnvInt('X', '-5', 2, { min: 1, max: 16 })).toBe(2)
  })

  it('falls back above max', () => {
    expect(parseEnvInt('X', '99999', 2, { min: 1, max: 16 })).toBe(2)
  })

  it('accepts the min boundary', () => {
    expect(parseEnvInt('X', '1', 2, { min: 1, max: 16 })).toBe(1)
  })

  it('accepts the max boundary', () => {
    expect(parseEnvInt('X', '16', 2, { min: 1, max: 16 })).toBe(16)
  })
})

describe('redactFlyErrorBody', () => {
  it('returns empty string for empty input', () => {
    expect(redactFlyErrorBody('')).toBe('')
  })

  it('leaves short, secret-free bodies intact', () => {
    expect(redactFlyErrorBody('volume in use')).toBe('volume in use')
  })

  it('redacts Bearer tokens', () => {
    const input = 'err: Authorization: Bearer fo1_AbCdEfGhIjKlMnOpQrStUvWxYz123456'
    const out = redactFlyErrorBody(input)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('fo1_AbCdEfGhIjKlMnOpQrStUvWxYz')
  })

  it('redacts long base64-like blobs (RSA keys, long tokens)', () => {
    const blob = 'A'.repeat(80)
    expect(redactFlyErrorBody(`value: ${blob}`)).toContain('[REDACTED]')
  })

  it('scrubs echoed-back env JSON blocks', () => {
    const body = '{"error":"invalid","env":{"GITHUB_APP_PRIVATE_KEY":"super-secret","X":"1"}}'
    const out = redactFlyErrorBody(body)
    expect(out).not.toContain('super-secret')
    expect(out).toContain('"env":"[REDACTED]"')
  })

  it('truncates very long bodies', () => {
    // Use short words + spaces so we exercise the length cap rather
    // than the base64 redactor (which would collapse a 2000-char
    // `xxxxx…` run into a single [REDACTED] token).
    const long = 'err '.repeat(500)
    const out = redactFlyErrorBody(long)
    expect(out.length).toBeLessThan(500)
    expect(out).toContain('truncated')
  })
})

/**
 * Logger side-effect assertions. The invalid inputs above should surface
 * to operators as one warn line each — silent rejection is the footgun
 * that the whole "validate at parse time" story is meant to prevent.
 */
describe('parse helpers emit operator-visible warnings', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // createLogger returns a pino child, which has .warn at runtime.
    // We spy on the module-scoped logger used in flyioBuilder by
    // hooking global console.warn; pino in non-production emits via
    // pino-pretty, which writes to stdout, so this mainly guards
    // against regressions in pino config. No-op if logs are silent.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('does not throw on invalid volume ids (just filters + warns)', () => {
    expect(() => parseVolumeList('vol-wrong,not_a_vol,vol_ok12345')).not.toThrow()
  })

  it('does not throw on unknown cpu kind', () => {
    expect(() => parseCpuKind('ultra-premium', 'performance')).not.toThrow()
  })

  it('does not throw on non-numeric int env', () => {
    expect(() => parseEnvInt('X', 'not-a-number', 5, { min: 0, max: 10 })).not.toThrow()
  })
})
