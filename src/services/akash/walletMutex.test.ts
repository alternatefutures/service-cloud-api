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
    it('serializes concurrent callers in FIFO order', async () => {
      const order: number[] = []
      const sleep = (ms: number) =>
        new Promise<void>(resolve => setTimeout(resolve, ms))

      const makeTask = (id: number, durationMs: number) =>
        withWalletLock(async () => {
          order.push(id)
          await sleep(durationMs)
          order.push(id + 100) // "finish" marker
        })

      // Start three concurrent tasks with different durations. Without the
      // mutex their start/finish markers would interleave; with the mutex
      // we expect [1, 101, 2, 102, 3, 103].
      await Promise.all([makeTask(1, 20), makeTask(2, 5), makeTask(3, 10)])

      expect(order).toEqual([1, 101, 2, 102, 3, 103])
    })

    it('does not poison the queue when a task rejects', async () => {
      const order: string[] = []

      const failing = withWalletLock(async () => {
        order.push('A-start')
        throw new Error('boom')
      })

      const succeeding = withWalletLock(async () => {
        order.push('B-start')
        return 'B-result'
      })

      await expect(failing).rejects.toThrow('boom')
      await expect(succeeding).resolves.toBe('B-result')
      expect(order).toEqual(['A-start', 'B-start'])
    })

    it('returns the inner function result', async () => {
      const result = await withWalletLock(async () => 42)
      expect(result).toBe(42)
    })
  })
})
