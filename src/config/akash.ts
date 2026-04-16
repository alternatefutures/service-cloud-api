/**
 * Shared Akash constants.
 *
 * Single source of truth for chain-geometry numbers (block time, sequence
 * settle delay, post-lease buffer) that were previously duplicated across
 * the billing scheduler, escrow health monitor, and deployment step worker.
 */

/**
 * Akash averages ~6s per block. 600 blocks ≈ 1 hour — close enough that
 * we use it as the hourly unit when converting pricePerBlock (uact/block)
 * into hourly burn. If Akash changes block time, update this constant.
 */
export const BLOCKS_PER_HOUR = 600

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
