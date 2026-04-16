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
 * The in-loop TX_NONCE_DELAY_MS only serialized within ONE caller; this
 * process-wide mutex serializes across ALL callers using the same wallet.
 *
 * Only chain TX submissions must go through this lock. Read-only queries
 * (query, keys show, status) and provider-services calls do NOT need it.
 *
 * This is a simple FIFO chain-of-promises; callers are served in the order
 * they call `withWalletLock()`. Timeouts on individual TXs (enforced by
 * execAsync) prevent a single hung call from permanently blocking the queue.
 */

let chain: Promise<unknown> = Promise.resolve()

export function withWalletLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = chain
  let release!: () => void
  const next = new Promise<void>(resolve => {
    release = resolve
  })
  chain = next
  return prev
    .catch(() => undefined) // never let a prior failure poison the queue
    .then(() => fn())
    .finally(() => release())
}

/**
 * Returns true if the first CLI arg is `tx` — i.e. this call mutates chain
 * state and needs to be serialized on the wallet's sequence number.
 */
export function isWalletTx(args: readonly string[]): boolean {
  return args[0] === 'tx'
}
