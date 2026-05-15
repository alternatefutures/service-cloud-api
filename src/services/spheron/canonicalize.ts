/**
 * Canonical-slug bridge between Spheron's `gpuType` strings and Akash's
 * lowercase model slugs.
 *
 * Why this file exists
 * --------------------
 * The deploy-form GPU dropdown writes Akash-canonical slugs into
 * `policy.acceptableGpuModels` (e.g. `'rtxa4000'`, `'pro6000se'`,
 * `'a100'`). Spheron's `/api/gpu-offers` returns its own naming
 * (`'A4000_PCIE'`, `'RTXPRO6000_PCIE'`, `'A100_80G_PCIE'`). The pre-Phase-50
 * picker did a naive case-insensitive substring match against the offer's
 * `gpuType` / `name` fields — which silently false-NO-MATCH'd whenever the
 * two namespaces disagreed (most workstation cards: Akash `rtxaXXXX`,
 * Spheron `AXXXX`). The auto-router would then quietly NO_CAPACITY-fall back
 * to Akash even when Spheron had the requested SKU sitting available.
 *
 * Two pure helpers solve it on both directions:
 *
 *   - `canonicalizeSpheronGpuType(spheronGpuType)` → Akash slug.
 *     Used by the picker (haystack side) and by
 *     `/internal/spheron-gpu-availability` to bucket offers under the
 *     same `(slug, vramGi)` keys the merged frontend dropdown indexes by.
 *
 *   - `canonicalizeAkashSlug(akashSlug)` → Spheron-style fragment.
 *     Used by the picker (needle side) for the substring fallback when an
 *     offer's gpuType isn't in the explicit map (forward-compat for new
 *     SKUs Spheron may surface before the map gets a row).
 *
 * Locked decisions
 * ----------------
 * - Stripping the interconnect / variant suffix is GENERIC: any of
 *   `_PCIE | _SXM2 | _SXM4 | _SXM5 | _SXM6 | _BAREMETAL | _LOW_RAM | _HIGH_PERF`
 *   is treated as cosmetic. Spheron's own offer's `interconnectType` field
 *   carries the SXM/PCIe distinction; we don't fold it into the canonical
 *   slug because the user's UX choice is GPU MODEL, not interconnect.
 * - VRAM suffix (`_80G`, `_32G`, `_16G`) is also stripped — VRAM is a
 *   secondary sort key in the merged dropdown, not part of the canonical
 *   slug. The frontend uses `(slug, vramGi)` as the row key so the same
 *   model appears on separate rows when it ships in materially different
 *   VRAM SKUs (A100 40 GB vs 80 GB).
 * - The explicit map handles the workstation-card prefix mismatch
 *   (Spheron `A4000` ↔ Akash `rtxa4000`) and the RTX PRO 6000 / RTX 6000 Ada
 *   tokens that don't follow either convention.
 * - `RTXPRO6000` resolves to `pro6000se` (server-edition) — the SE/WE
 *   distinction was made on price + provider distribution. If a future
 *   probe surfaces `RTXPRO6000_WE`
 *   we'll add a row to the map.
 *
 * Pinned 24 Spheron `gpuType` strings observed live 2026-05-10 13:30
 * (see `handoffs/2026-05-10_1330_spheron-gpu-dropdown-design-locked.md`):
 *   A100_80G_PCIE, A100_80G_SXM4, A4000_PCIE, A6000_PCIE, B200_SXM6,
 *   B300_SXM6, H100_PCIE, H200_SXM5, L40S_PCIE, L40_PCIE,
 *   RTXPRO6000_PCIE, A16_PCIE, GH200_PCIE, RTX6000ADA_PCIE,
 *   A5000_PCIE, V100_32G_SXM2, RTX4090_PCIE, RTX4080_PCIE,
 *   RTX3090_PCIE, RTX5090_PCIE, T4_PCIE, A40_PCIE, MI100_PCIE,
 *   MI60_PCIE.
 *
 * Pinned in the unit test next to this file. If a probe surfaces a new
 * gpuType, add it to the test fixture before shipping.
 */

const SUFFIX_PATTERNS: RegExp[] = [
  // Interconnect / variant — order matters: longest first so `_SXM6` doesn't
  // get partial-stripped by `_SXM` etc. We anchor each at end-of-string.
  /_PCIE$/i,
  /_SXM6$/i,
  /_SXM5$/i,
  /_SXM4$/i,
  /_SXM2$/i,
  /_BAREMETAL$/i,
  /_LOW_RAM$/i,
  /_HIGH_PERF$/i,
]

const VRAM_SUFFIX = /_(\d+)G$/i

/**
 * Map: Spheron token (post suffix-strip, upper-case) → Akash canonical slug.
 *
 * Only put rows here for SKUs where the prefix differs between namespaces
 * or where Spheron uses an idiosyncratic token (e.g. `RTXPRO6000`,
 * `RTX6000ADA`, `GH200`). The default path (lowercase the stripped token)
 * handles the common case where the slugs agree (`A100`, `H100`, `L40S`,
 * `B200`, `T4`, `A40`, `MI100`, `RTX4090`, etc.).
 */
const SPHERON_TO_AKASH_EXPLICIT: Record<string, string> = {
  // RTX A-series workstation: Spheron drops the `RTX` prefix.
  A4000: 'rtxa4000',
  A5000: 'rtxa5000',
  A6000: 'rtxa6000',
  A2000: 'rtxa2000',
  A16: 'a16',
  // RTX PRO 6000 — single-token in Spheron's catalog. Server edition by
  // price + provider distribution (see header).
  RTXPRO6000: 'pro6000se',
  // RTX 6000 Ada — single-token in Spheron's catalog.
  RTX6000ADA: 'rtx6000ada',
  // Grace Hopper — Akash hasn't standardised a slug yet; we use the most
  // common community shorthand `gh200`.
  GH200: 'gh200',
}

/**
 * Inverse map for the picker's substring fallback. Built lazily so the
 * forward map stays the single source of truth.
 */
let _akashToSpheronCache: Record<string, string> | null = null
function akashToSpheronMap(): Record<string, string> {
  if (_akashToSpheronCache) return _akashToSpheronCache
  const out: Record<string, string> = {}
  for (const [spheron, akash] of Object.entries(SPHERON_TO_AKASH_EXPLICIT)) {
    out[akash] = spheron
  }
  _akashToSpheronCache = out
  return out
}

/**
 * Canonicalise a Spheron `gpuType` (or `name` / `gpuModel` / `displayName`)
 * to the Akash-canonical slug used in `policy.acceptableGpuModels` and the
 * deploy-form GPU dropdown.
 *
 * Returns lowercase. Strips known suffixes, applies the explicit map,
 * else returns the lowercased stripped token.
 *
 * Examples (pinned in canonicalize.test.ts):
 *   'A100_80G_PCIE'    → 'a100'
 *   'H100_PCIE'        → 'h100'
 *   'A4000_PCIE'       → 'rtxa4000'
 *   'RTXPRO6000_PCIE'  → 'pro6000se'
 *   'RTX6000ADA_PCIE'  → 'rtx6000ada'
 *   'B300_SXM6'        → 'b300'
 *   'V100_32G_SXM2'    → 'v100'
 */
export function canonicalizeSpheronGpuType(input: string): string {
  if (!input) return ''
  let s = input.trim().toUpperCase()
  // Strip interconnect/variant suffix (single pass).
  for (const re of SUFFIX_PATTERNS) {
    if (re.test(s)) {
      s = s.replace(re, '')
      break
    }
  }
  // Strip VRAM suffix if present (`A100_80G` → `A100`).
  s = s.replace(VRAM_SUFFIX, '')
  // Apply the explicit map for prefix-mismatch SKUs.
  const explicit = SPHERON_TO_AKASH_EXPLICIT[s]
  if (explicit) return explicit
  return s.toLowerCase()
}

/**
 * Take an Akash-canonical slug (e.g. `'rtxa4000'`) and return a
 * Spheron-style upper-case token fragment (e.g. `'A4000'`) suitable for
 * substring matching against Spheron offer fields.
 *
 * Used as the FALLBACK match path in the picker — when the offer's
 * gpuType doesn't appear in `SPHERON_TO_AKASH_EXPLICIT` we still want
 * `acceptableGpuModels: ['h100']` to substring-match `H100_PCIE`.
 *
 * Examples:
 *   'rtxa4000'    → 'A4000'
 *   'pro6000se'   → 'RTXPRO6000'
 *   'rtx6000ada'  → 'RTX6000ADA'
 *   'h100'        → 'H100'   (no map row → upper-case the input)
 *   'a100'        → 'A100'
 */
export function canonicalizeAkashSlug(input: string): string {
  if (!input) return ''
  const lower = input.trim().toLowerCase()
  const mapped = akashToSpheronMap()[lower]
  if (mapped) return mapped
  return lower.toUpperCase()
}
