import { describe, expect, it } from 'vitest'
import { isWalletTx, withWalletLock } from './walletMutex.js'

describe('walletMutex', () => {
  describe('isWalletTx', () => {
    it('returns true for tx commands', () => {
      expect(isWalletTx(['tx', 'deployment', 'create'])).toBe(true)
      expect(isWalletTx(['tx', 'escrow', 'deposit', 'deployment'])).toBe(true)
    })

    it('returns false for read-only commands', () => {
      expect(isWalletTx(['query', 'deployment', 'get'])).toBe(false)
      expect(isWalletTx(['keys', 'show', 'default', '-a'])).toBe(false)
      expect(isWalletTx(['status'])).toBe(false)
      expect(isWalletTx([])).toBe(false)
    })
  })

  describe('withWalletLock', () => {
    // Tests pass settleMs: 0 to avoid the production 3s hold-after-TX delay.
    // The settle-delay behavior is tested separately below.

    it('serializes concurrent callers in FIFO order', async () => {
      const order: number[] = []
      const sleep = (ms: number) =>
        new Promise<void>(resolve => setTimeout(resolve, ms))

      const makeTask = (id: number, durationMs: number) =>
        withWalletLock(
          async () => {
            order.push(id)
            await sleep(durationMs)
            order.push(id + 100) // "finish" marker
          },
          { settleMs: 0 },
        )

      // Start three concurrent tasks with different durations. Without the
      // mutex their start/finish markers would interleave; with the mutex
      // we expect [1, 101, 2, 102, 3, 103].
      await Promise.all([makeTask(1, 20), makeTask(2, 5), makeTask(3, 10)])

      expect(order).toEqual([1, 101, 2, 102, 3, 103])
    })

    it('does not poison the queue when a task rejects', async () => {
      const order: string[] = []

      const failing = withWalletLock(
        async () => {
          order.push('A-start')
          throw new Error('boom')
        },
        { settleMs: 0 },
      )

      const succeeding = withWalletLock(
        async () => {
          order.push('B-start')
          return 'B-result'
        },
        { settleMs: 0 },
      )

      await expect(failing).rejects.toThrow('boom')
      await expect(succeeding).resolves.toBe('B-result')
      expect(order).toEqual(['A-start', 'B-start'])
    })

    it('returns the inner function result', async () => {
      const result = await withWalletLock(async () => 42, { settleMs: 0 })
      expect(result).toBe(42)
    })

    it('holds the lock for settleMs after fn() resolves', async () => {
      // The next caller must NOT start running until the previous caller's
      // settle window elapses. This is what prevents account-sequence
      // collisions under broadcast-mode=sync.
      const timings: Array<{ id: string; at: number }> = []
      const t0 = Date.now()
      const mark = (id: string) => timings.push({ id, at: Date.now() - t0 })

      const first = withWalletLock(
        async () => {
          mark('A-start')
          // Simulate a fast CLI return (mempool acceptance).
          mark('A-fn-resolve')
        },
        { settleMs: 80 },
      )

      const second = withWalletLock(
        async () => {
          mark('B-start')
        },
        { settleMs: 0 },
      )

      await Promise.all([first, second])

      const aStart = timings.find(t => t.id === 'A-start')!.at
      const aResolve = timings.find(t => t.id === 'A-fn-resolve')!.at
      const bStart = timings.find(t => t.id === 'B-start')!.at

      expect(aStart).toBeGreaterThanOrEqual(0)
      expect(aResolve).toBeGreaterThanOrEqual(aStart)
      // B must start >= 80ms after A's fn resolved (the settle window).
      expect(bStart - aResolve).toBeGreaterThanOrEqual(70) // small tolerance
    })

    it('holds the lock for settleMs even when fn() rejects', async () => {
      // Sequence collisions care about the CLI call having returned, not
      // about whether the JS promise resolved or rejected. The chain may
      // still commit a TX even if our CLI errored out on parse/post-check.
      const timings: Array<{ id: string; at: number }> = []
      const t0 = Date.now()
      const mark = (id: string) => timings.push({ id, at: Date.now() - t0 })

      const first = withWalletLock(
        async () => {
          mark('A-start')
          throw new Error('chain-rejected')
        },
        { settleMs: 80 },
      ).catch(() => {
        /* swallow */
      })

      const second = withWalletLock(
        async () => {
          mark('B-start')
        },
        { settleMs: 0 },
      )

      await Promise.all([first, second])

      const aStart = timings.find(t => t.id === 'A-start')!.at
      const bStart = timings.find(t => t.id === 'B-start')!.at
      expect(bStart - aStart).toBeGreaterThanOrEqual(70)
    })
  })
})
