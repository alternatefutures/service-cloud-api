/**
 * Wallet-scoped async mutex for Akash chain transactions.
 *
 * Why: every `akash tx ...` submission from AKASH_FROM consumes a Cosmos
 * account sequence number. When the billing cron, escrow health monitor,
 * pause handler, user-initiated close resolver, and deployment step workers
 * all submit TXs concurrently, the chain can reject them with
 * `account sequence mismatch` — and with our previous silent-return behavior
 * on top-ups, that rejection could drain on-chain escrow unnoticed.
 *
 * Important: by default we run the CLI with `AKASH_BROADCAST_MODE=sync`,
 * which returns as soon as the TX is accepted into the mempool — NOT when
 * it is committed to a block. The account sequence on-chain only advances
 * after block inclusion (~6s on Akash). If the mutex released the moment
 * `fn()` resolved, the next caller would query the chain for the latest
 * sequence, see the pre-TX value, and collide. We therefore hold the lock
 * for a short "settle" window after `fn()` resolves, giving the chain time
 * to commit the previous TX before the next one reads the sequence.
 *
 * Query commands (query, keys show, status) and provider-services calls
 * do NOT need this — they don't touch the account sequence. Use
 * `withWalletLock(fn, { settleMs: 0 })` if a caller wants mutex ordering
 * without the post-settle delay (e.g. a TX already broadcast in `block`
 * mode, where block inclusion is guaranteed before `fn()` resolves).
 *
 * This is a simple FIFO chain-of-promises; callers are served in the order
 * they call `withWalletLock()`. Timeouts on individual TXs (enforced by
 * execAsync) prevent a single hung call from permanently blocking the queue.
 */

import { TX_SETTLE_DELAY_MS } from '../../config/akash.js'

let chain: Promise<unknown> = Promise.resolve()

export interface WalletLockOptions {
  /**
   * Milliseconds to hold the lock AFTER fn() resolves, so the chain can
   * commit the TX before the next caller reads the account sequence.
   * Defaults to TX_SETTLE_DELAY_MS. Pass 0 for non-TX work or for TXs
   * broadcast in `block` mode (already block-waited by the CLI).
   */
  settleMs?: number
}

export function withWalletLock<T>(
  fn: () => Promise<T>,
  opts: WalletLockOptions = {},
): Promise<T> {
  const settleMs = opts.settleMs ?? TX_SETTLE_DELAY_MS
  const prev = chain
  let release!: () => void
  const next = new Promise<void>(resolve => {
    release = resolve
  })
  chain = next

  let result: T
  let caught: unknown
  let rejected = false

  return prev
    .catch(() => undefined) // never let a prior failure poison the queue
    .then(() => fn())
    .then(
      v => {
        result = v
      },
      e => {
        caught = e
        rejected = true
      },
    )
    .then(() => (settleMs > 0 ? sleep(settleMs) : undefined))
    .finally(() => release())
    .then(() => {
      if (rejected) throw caught
      return result
    })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Returns true if the first CLI arg is `tx` — i.e. this call mutates chain
 * state and needs to be serialized on the wallet's sequence number.
 */
export function isWalletTx(args: readonly string[]): boolean {
  return args[0] === 'tx'
}
