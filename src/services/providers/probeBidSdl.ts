/**
 * GPU bid-probe SDL generator.
 *
 * The probe is a deliberately tiny deployment whose only purpose is to
 * surface real-world bid prices from every provider that owns the
 * targeted GPU model. We never actually lease — the probe runner closes
 * the deployment as soon as bids arrive.
 *
 * Why a high pricing ceiling (100_000 uact/block ≈ $1.4k/day):
 *   - Akash bids must be at-or-below the offer price. We want EVERY
 *     honest provider's real price, which is well under $5/hr in
 *     practice for any GPU model. A ceiling 10× above the worst-case
 *     real bid leaves zero room for "could not bid" excuses.
 *   - We never accept the lease, so the ceiling is academic — there is
 *     no risk of overspending here. The probe runner closes the dseq
 *     before any escrow burn beyond a few seconds of block fees
 *     (~$0.0015 per probe).
 *
 * Sanity guard: rollup discards observed bids above MAX_PROBE_BID_UACT
 * (see `gpuBidProbe.ts`) so a malicious provider bidding the ceiling
 * itself can't poison the percentile calculations.
 */

export type GpuVendor = 'nvidia' | 'amd'

/**
 * Strict whitelist for what we'll splice into the SDL YAML. Lower-case
 * alphanumerics + dash only; matches the canonical model strings used
 * throughout the registry (e.g. "h100", "rtx4090", "mi300x").
 */
const SAFE_TOKEN_RE = /^[a-z0-9-]+$/

/** Bid ceiling in uact/block. See header for sizing rationale. */
export const PROBE_PRICING_CEILING_UACT = 100_000

export function buildProbeSdl(
  gpuModel: string,
  vendor: GpuVendor = 'nvidia'
): string {
  const model = gpuModel.toLowerCase().trim()
  if (!SAFE_TOKEN_RE.test(model)) {
    throw new Error(`Invalid gpu model token: ${JSON.stringify(gpuModel)}`)
  }
  if (vendor !== 'nvidia' && vendor !== 'amd') {
    throw new Error(`Invalid gpu vendor: ${JSON.stringify(vendor)}`)
  }

  // Image is `alpine:3` + a 60s sleep — long enough to receive bids,
  // short enough that even if our `tx deployment close` somehow fails
  // the workload self-terminates before billing more than a fraction of
  // a cent. The orchestrator + escrowHealthMonitor's chain-orphan sweep
  // catch any actually-leased orphans separately.
  return `---
version: "2.0"
services:
  probe:
    image: alpine:3
    command: ["sleep", "60"]
    expose:
      - port: 80
        as: 80
        to:
          - global: true
profiles:
  compute:
    probe:
      resources:
        cpu:
          units: 1
        memory:
          size: 256Mi
        storage:
          size: 256Mi
        gpu:
          units: 1
          attributes:
            vendor:
              ${vendor}:
                - model: ${model}
  placement:
    any:
      pricing:
        probe:
          denom: uact
          amount: ${PROBE_PRICING_CEILING_UACT}
deployment:
  probe:
    any:
      profile: probe
      count: 1
`
}
