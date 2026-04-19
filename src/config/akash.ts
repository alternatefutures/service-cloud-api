/**
 * Shared Akash constants.
 *
 * Single source of truth for chain-geometry numbers (block time, sequence
 * settle delay, post-lease buffer) that were previously duplicated across
 * the billing scheduler, escrow health monitor, and deployment step worker.
 */

/**
 * Akash chain block geometry.
 *
 * Empirically measured block time on mainnet is ~6.117s (matches the
 * upstream provider bid-pricing reference script,
 * https://gist.github.com/chainzero/33978bf221eb35f10a7392ed9bae8caa
 * which uses `429,909 blocks/month` at 30.437 days/month).
 *
 * Previous value (6.0s → 600 blocks/hour, 14400 blocks/day) over-charged
 * deployments by ~1.95% in our USD/hour and refill calculations. Aligning
 * with the upstream constant makes our cost reporting and on-chain escrow
 * top-ups match the actual chain burn rate.
 *
 * If Akash changes block time materially, update SECONDS_PER_BLOCK and the
 * derived constants below.
 */
export const AKASH_SECONDS_PER_BLOCK = 6.117

/** 3600 / 6.117 ≈ 588.5 — rounded down so refills slightly under-fund rather than over-fund. */
export const BLOCKS_PER_HOUR = 588

/** 86400 / 6.117 ≈ 14124.6 — rounded down for the same reason. */
export const BLOCKS_PER_DAY = 14_124

/** Matches `429,909 blocks/month` from upstream price_script_generic.sh. */
export const BLOCKS_PER_MONTH = 429_909

/**
 * How long to hold the wallet mutex AFTER a `akash tx ...` CLI invocation
 * returns, so the chain has time to commit the TX before the next caller
 * reads the account sequence number.
 *
 * Required because our default broadcast mode is `sync` (returns on
 * mempool acceptance, not block inclusion). Block time is ~6s; 3s is the
 * empirically-tuned minimum that works reliably in production.
 *
 * This value is the mutex's internal delay — callers should NOT add
 * their own `setTimeout` after a TX. If a caller uses broadcast mode
 * `block`, pass `{ settleMs: 0 }` to `withWalletLock` to skip this delay.
 */
export const TX_SETTLE_DELAY_MS = 3_000

/**
 * How many hours of on-chain escrow runway to fund after a lease is
 * accepted (on top of the initial 1 ACT deposit from deployment create).
 *
 * Why 2 (not 1): deployments created mid-hour can miss the billing cron
 * at :00 (the scheduler skips runs that happened "too soon" after the
 * previous cycle). With only 1 hour of post-lease runway, a lease created
 * at e.g. :45 can burn its buffer before the first billing-cron top-up at
 * the next :00. 2 hours guarantees the billing scheduler gets at least
 * one successful top-up before the escrow enters the danger zone.
 */
export const POST_LEASE_HOURS = 2
