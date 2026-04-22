import { describe, expect, it } from 'vitest'
import { __test__ } from './flyioBuilder.js'

const { parseVolumeList } = __test__

/**
 * `FLY_BUILDER_CACHE_VOLUME` is parsed by `parseVolumeList` into the
 * volume pool that `spawnFlyBuilder` rotates through on 409 volume-busy.
 * These are thin tests but they pin the contract because mis-parsing is
 * silent: an extra space in the configmap would drop every build back to
 * ephemeral state and nothing would alert.
 */
describe('parseVolumeList', () => {
  it('returns an empty list when the env var is unset', () => {
    expect(parseVolumeList(undefined)).toEqual([])
  })

  it('returns an empty list for an empty string', () => {
    expect(parseVolumeList('')).toEqual([])
  })

  it('parses a single volume id', () => {
    expect(parseVolumeList('vol_abc')).toEqual(['vol_abc'])
  })

  it('parses multiple comma-separated ids', () => {
    expect(parseVolumeList('vol_a,vol_b,vol_c')).toEqual(['vol_a', 'vol_b', 'vol_c'])
  })

  it('trims surrounding whitespace around each id (YAML users love spaces after commas)', () => {
    expect(parseVolumeList(' vol_a , vol_b ,vol_c ')).toEqual(['vol_a', 'vol_b', 'vol_c'])
  })

  it('filters out empty entries from trailing or doubled commas', () => {
    // Defensive: a user who leaves a trailing comma shouldn't get an
    // empty string routed to Fly's mounts[].volume — that would fail
    // with a confusing "volume '' not found" error on every spawn.
    expect(parseVolumeList('vol_a,,vol_b,')).toEqual(['vol_a', 'vol_b'])
  })
})
