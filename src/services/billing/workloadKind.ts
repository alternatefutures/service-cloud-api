/**
 * Workload-kind resolvers per provider.
 *
 * Maps a deployment row from each provider to a `WorkloadKind` value
 * (`gpu` / `cvm` / `cpu`) that the billing config (`config/billing.ts`)
 * uses to look up the minimum-billable-runtime floor.
 *
 * Lives in the billing folder (not provider adapters) because the
 * concept is billing-specific — providers themselves don't care about
 * "kind", they care about the actual GPU SKU. When adding a new
 * provider, add a `getXxxWorkloadKind()` here in the same shape and
 * wire the corresponding final-settlement path to call it.
 *
 * Pure functions, no DB or HTTP. Each accepts the minimum row shape
 * it needs so callers can `select` only what's required.
 */
import type { WorkloadKind } from '../../config/billing.js'

/**
 * Spheron sells GPU VMs only. Every row is a GPU workload.
 *
 * Kept as a function (not a constant) for symmetry with the other two
 * providers — adding a future "Spheron CPU offer" would just thread a
 * row through here instead of touching every call site.
 */
export function getSpheronWorkloadKind(
  // Reserved for future per-row branching (e.g. Spheron CPU offers).
  // Underscore prefix tells the linter we deliberately don't read it yet.
  // Typed as a structurally-open object so callers can hand in the
  // narrowest `select` they already had to fetch (gpuType / gpuCount /
  // anything) without TypeScript flagging the call.
  _row: Record<string, unknown> = {},
): WorkloadKind {
  return 'gpu'
}

/**
 * Phala CVMs come in TDX-only flavours (tdx.small … tdx.4xlarge — pure
 * CVM, no GPU) and TDX+GPU flavours (h200.small / h200.16xlarge /
 * h200.8x.large — confidential GPU compute).
 *
 *   - `row.gpuModel` is set at deploy time when the user picks a GPU CVM
 *     (post-Phase-50ish). Treat any non-null/non-empty value as GPU.
 *   - Fallback: `row.cvmSize` begins with a known GPU prefix. Conservative
 *     match (`h200.`, `h100.`, `b200.`) so a future TDX-only `h-class`
 *     CPU CVM doesn't get mislabelled.
 */
const PHALA_GPU_CVM_PREFIXES = ['h200.', 'h100.', 'b200.']

export function getPhalaWorkloadKind(row: {
  gpuModel?: string | null
  cvmSize?: string | null
}): WorkloadKind {
  if (row.gpuModel && row.gpuModel.trim().length > 0) return 'gpu'
  const size = row.cvmSize?.toLowerCase() ?? ''
  for (const prefix of PHALA_GPU_CVM_PREFIXES) {
    if (size.startsWith(prefix)) return 'gpu'
  }
  return 'cvm'
}

/**
 * Akash deployments are CPU by default; `gpuModel` is populated by the
 * post-lease provider probe whenever the lease was awarded a GPU
 * resource (`gpu_count > 0` in the SDL). Settlement happens after
 * lease creation, so by the time the floor lookup runs, `gpuModel`
 * is the source of truth.
 *
 * Failed-before-lease deployments have `gpuModel = null` AND
 * `pricePerBlock = null`, so they bill at $0 and the floor would
 * apply to nothing — safe to default to `cpu`.
 */
export function getAkashWorkloadKind(row: {
  gpuModel?: string | null
}): WorkloadKind {
  if (row.gpuModel && row.gpuModel.trim().length > 0) return 'gpu'
  return 'cpu'
}
