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

import type { PrismaClient } from '@prisma/client'
import { TX_SETTLE_DELAY_MS } from '../../config/akash.js'
import { createLogger } from '../../lib/logger.js'

const advisoryLog = createLogger('wallet-advisory-lock')

// pg_advisory_lock takes a 32-bit signed int OR two 32-bit ints. We use
// a single fixed key so EVERY chain-tx replica blocks on the same lock.
// Choose anything as long as it does not collide with another use of
// pg_advisory_lock in the same database. 0x414b4148 = "AKAH".
const ADVISORY_LOCK_KEY = 0x414b4148

// Allow ops to disable the cross-replica lock (useful for tests, single-
// replica dev deploys, or emergencies). The in-process FIFO chain still
// works on its own — we only LOSE the cross-replica guarantee.
const ADVISORY_LOCK_DISABLED = process.env.WALLET_ADVISORY_LOCK_DISABLED === 'true'
const ADVISORY_LOCK_TIMEOUT_MS = parseInt(
  process.env.WALLET_ADVISORY_LOCK_TIMEOUT_MS ?? '60000',
  10,
)

let chain: Promise<unknown> = Promise.resolve()

// Set once at boot from `index.ts` (see `setWalletMutexPrisma`). The
// advisory-lock TX needs a Prisma handle but `walletMutex` is imported
// from many places (resolvers, schedulers, queue workers) and we don't
// want to thread `prisma` through every call site. Module-level state
// is fine here: the process has exactly one Prisma client.
let sharedPrisma: PrismaClient | null = null

export function setWalletMutexPrisma(prisma: PrismaClient): void {
  sharedPrisma = prisma
}

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
    .then(() => withChainAdvisoryLock(fn))
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

/**
 * Wrap `fn` in a Postgres advisory lock so chain TX serialization holds
 * across replicas. Without this, two pods could both pass the in-process
 * `chain` mutex simultaneously and submit concurrent TXs from the same
 * Cosmos account — guaranteed sequence-mismatch rejection.
 *
 * We use `pg_advisory_xact_lock` inside a Prisma transaction so the
 * lock is bound to the connection AND released automatically on commit
 * or error. The TX itself does no DB work; it exists only to hold the
 * connection that owns the advisory lock.
 *
 * Disabled via `WALLET_ADVISORY_LOCK_DISABLED=true` for environments
 * with a single replica (the in-process FIFO is enough on its own).
 */
async function withChainAdvisoryLock<T>(fn: () => Promise<T>): Promise<T> {
  if (ADVISORY_LOCK_DISABLED) return fn()
  if (!sharedPrisma) {
    // Test environment or early bootstrap (before setWalletMutexPrisma
    // ran). Skip the cross-replica lock — in-process FIFO still works.
    return fn()
  }

  return sharedPrisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
      return fn()
    },
    {
      // The TX must outlive the chain command. `runAkashTxAsync` waits
      // for block inclusion (~6s typical, much longer if RPC is slow),
      // so we give it generous headroom. Tune via env if needed.
      timeout: ADVISORY_LOCK_TIMEOUT_MS,
      maxWait: ADVISORY_LOCK_TIMEOUT_MS,
    },
  ).catch((err) => {
    advisoryLog.error({ err }, 'pg advisory-lock TX failed — falling back to in-process lock only')
    // If the lock TX itself failed (DB down, etc.) we still want the
    // command to attempt — better to risk a sequence collision than
    // freeze every chain operation.
    return fn()
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
