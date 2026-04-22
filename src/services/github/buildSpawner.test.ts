import { describe, expect, it } from 'vitest'
import { escapeYamlValue } from './buildSpawner.js'

/**
 * `escapeYamlValue` is interpolated into a YAML *double-quoted scalar*
 * inside `infra/k8s/builder/job.template.yaml` — `value: "<here>"`.
 *
 * The threat model isn't generic YAML safety; it's specifically:
 *   1. closing the quote and injecting a sibling key (`"; injected: …`)
 *   2. embedding a literal newline that aborts scalar parsing mid-string
 *   3. backslash sequences that confuse the YAML escape decoder
 *
 * Tests below pin the contract explicitly so a future refactor doesn't
 * silently regress the escape semantics that the GHCR/clone-URL plumbing
 * depends on.
 */
describe('escapeYamlValue', () => {
  it('escapes embedded double quotes so the surrounding scalar stays well-formed', () => {
    expect(escapeYamlValue('foo"bar')).toBe('foo\\"bar')
  })

  it('escapes backslashes BEFORE other escapes so we never double-escape', () => {
    // The order matters: if `\\` were escaped after `\"`, then a literal
    // input of `\"` would get turned into `\\\\"` instead of `\\\"`.
    expect(escapeYamlValue('a\\b')).toBe('a\\\\b')
    expect(escapeYamlValue('a\\"b')).toBe('a\\\\\\"b')
  })

  it('escapes newlines and carriage returns into their YAML escape sequences', () => {
    expect(escapeYamlValue('line1\nline2')).toBe('line1\\nline2')
    expect(escapeYamlValue('line1\r\nline2')).toBe('line1\\r\\nline2')
  })

  it('escapes tabs', () => {
    expect(escapeYamlValue('col1\tcol2')).toBe('col1\\tcol2')
  })

  it('passes through plain values unchanged', () => {
    expect(escapeYamlValue('ghp_abcDEF1234567890')).toBe('ghp_abcDEF1234567890')
    expect(escapeYamlValue('https://x-access-token:abc@github.com/o/r.git')).toBe(
      'https://x-access-token:abc@github.com/o/r.git',
    )
  })

  it('handles the empty string without throwing', () => {
    expect(escapeYamlValue('')).toBe('')
  })

  it('blocks the obvious YAML-scalar injection vector', () => {
    // An adversary who controls a token tries to close our quote and
    // inject a sibling key. After escaping, the closing-quote character
    // must still be neutralized so the YAML parser sees a single scalar.
    const malicious = '"; injected: pwned'
    const escaped = escapeYamlValue(malicious)
    // Most importantly, no UNESCAPED double-quote remains. Every `"` in
    // the output must be preceded by a backslash.
    for (let i = 0; i < escaped.length; i += 1) {
      if (escaped[i] === '"') {
        expect(escaped[i - 1]).toBe('\\')
      }
    }
  })
})
