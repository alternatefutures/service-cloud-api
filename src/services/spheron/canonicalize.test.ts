/**
 * Pin-down test for the Spheron ↔ Akash canonical-slug bridge.
 *
 * The bridge is the only thing protecting the deploy-form "Standard" tile
 * from silently NO_CAPACITY-falling back to Akash whenever a user picks
 * a workstation card whose Spheron token disagrees with Akash's slug
 * (`A4000_PCIE` ↔ `rtxa4000`, `RTXPRO6000_PCIE` ↔ `pro6000se`, etc.).
 *
 * Every `gpuType` observed live on 2026-05-10 13:30 is asserted here
 * against the Akash slug the merged dropdown will write into the policy.
 * If a probe surfaces a new token, add a fixture row before shipping —
 * the unit test is the contract.
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalizeSpheronGpuType,
  canonicalizeAkashSlug,
} from './canonicalize.js'

describe('canonicalizeSpheronGpuType', () => {
  it.each([
    // Data-center / HPC — Spheron and Akash slugs agree after suffix-strip.
    ['A100_80G_PCIE', 'a100'],
    ['A100_80G_SXM4', 'a100'],
    ['H100_PCIE', 'h100'],
    ['H200_SXM5', 'h200'],
    ['L40_PCIE', 'l40'],
    ['L40S_PCIE', 'l40s'],
    ['B200_SXM6', 'b200'],
    ['B300_SXM6', 'b300'],
    ['T4_PCIE', 't4'],
    ['A40_PCIE', 'a40'],
    ['V100_32G_SXM2', 'v100'],
    // Workstation / RTX A — Spheron drops the `RTX` prefix, explicit map.
    ['A4000_PCIE', 'rtxa4000'],
    ['A5000_PCIE', 'rtxa5000'],
    ['A6000_PCIE', 'rtxa6000'],
    ['A2000_PCIE', 'rtxa2000'],
    ['A16_PCIE', 'a16'],
    // RTX PRO 6000 / RTX 6000 Ada — explicit-map idiosyncrasies.
    ['RTXPRO6000_PCIE', 'pro6000se'],
    ['RTX6000ADA_PCIE', 'rtx6000ada'],
    // Grace Hopper.
    ['GH200_PCIE', 'gh200'],
    // Consumer RTX — slugs agree.
    ['RTX4090_PCIE', 'rtx4090'],
    ['RTX4080_PCIE', 'rtx4080'],
    ['RTX3090_PCIE', 'rtx3090'],
    ['RTX5090_PCIE', 'rtx5090'],
    // AMD.
    ['MI100_PCIE', 'mi100'],
    ['MI60_PCIE', 'mi60'],
  ])('%s → %s', (gpuType, expected) => {
    expect(canonicalizeSpheronGpuType(gpuType)).toBe(expected)
  })

  it('returns empty string on empty input', () => {
    expect(canonicalizeSpheronGpuType('')).toBe('')
  })

  it('handles lowercase input (offer.name often lowercased)', () => {
    expect(canonicalizeSpheronGpuType('h100_pcie')).toBe('h100')
    expect(canonicalizeSpheronGpuType('a4000_pcie')).toBe('rtxa4000')
  })

  it('strips VRAM suffix when present without an interconnect suffix', () => {
    expect(canonicalizeSpheronGpuType('V100_32G')).toBe('v100')
    expect(canonicalizeSpheronGpuType('A100_80G')).toBe('a100')
  })

  it('falls through to lowercase token when no suffix or map row matches', () => {
    expect(canonicalizeSpheronGpuType('FUTURESKU')).toBe('futuresku')
  })

  it('strips _BAREMETAL / _LOW_RAM / _HIGH_PERF variants', () => {
    expect(canonicalizeSpheronGpuType('H100_BAREMETAL')).toBe('h100')
    expect(canonicalizeSpheronGpuType('A100_LOW_RAM')).toBe('a100')
    expect(canonicalizeSpheronGpuType('H100_HIGH_PERF')).toBe('h100')
  })
})

describe('canonicalizeAkashSlug', () => {
  it.each([
    // Inverse of the explicit map.
    ['rtxa4000', 'A4000'],
    ['rtxa5000', 'A5000'],
    ['rtxa6000', 'A6000'],
    ['rtxa2000', 'A2000'],
    ['pro6000se', 'RTXPRO6000'],
    ['rtx6000ada', 'RTX6000ADA'],
    ['gh200', 'GH200'],
    ['a16', 'A16'],
    // Default path: upper-case the slug.
    ['h100', 'H100'],
    ['a100', 'A100'],
    ['l40s', 'L40S'],
    ['rtx4090', 'RTX4090'],
    ['mi100', 'MI100'],
  ])('%s → %s', (akashSlug, expected) => {
    expect(canonicalizeAkashSlug(akashSlug)).toBe(expected)
  })

  it('returns empty string on empty input', () => {
    expect(canonicalizeAkashSlug('')).toBe('')
  })

  it('is case-insensitive on input', () => {
    expect(canonicalizeAkashSlug('RTXA4000')).toBe('A4000')
    expect(canonicalizeAkashSlug('PRO6000SE')).toBe('RTXPRO6000')
  })
})

describe('round-trip identity (the load-bearing property)', () => {
  // For every Spheron gpuType the picker might see, the canonical Akash
  // slug must round-trip back to a string that substring-matches the
  // ORIGINAL gpuType. This is what unblocks the "user picked rtxa4000"
  // path in offerPicker.gpuMatchesAcceptable.
  const ROUND_TRIPS: Array<[string, string]> = [
    ['A100_80G_PCIE', 'a100'],
    ['H100_PCIE', 'h100'],
    ['A4000_PCIE', 'rtxa4000'],
    ['RTXPRO6000_PCIE', 'pro6000se'],
    ['RTX6000ADA_PCIE', 'rtx6000ada'],
    ['GH200_PCIE', 'gh200'],
    ['L40S_PCIE', 'l40s'],
  ]

  it.each(ROUND_TRIPS)('%s ⇄ %s', (gpuType, akashSlug) => {
    expect(canonicalizeSpheronGpuType(gpuType)).toBe(akashSlug)
    const fragment = canonicalizeAkashSlug(akashSlug)
    expect(gpuType.toUpperCase()).toContain(fragment)
  })
})
