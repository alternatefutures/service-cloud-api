/**
 * Akash On-Chain Escrow Health Monitor
 *
 * Monitors the on-chain escrow balance for active Akash deployments and
 * auto-refills from the deployer wallet's ACT balance before the escrow
 * depletes (which would cause Akash to close the lease).
 *
 * This operates at the infrastructure level (platform's deployer wallet),
 * separate from the user-facing org wallet billing.
 *
 * Schedule: every 10 minutes for fast reaction to expensive GPU leases.
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { BILLING_CONFIG } from '../../config/billing.js'
import { createLogger } from '../../lib/logger.js'
import { getAkashEnv } from '../../lib/akashEnv.js'
import { execAsync } from '../queue/asyncExec.js'

const log = createLogger('escrow-health')

const AKASH_CLI_TIMEOUT_MS = 30_000
const MIN_ESCROW_HOURS = 1
const REFILL_HOURS = 1

/** Warn when deployer wallet ACT balance falls below this (5 ACT). */
const LOW_WALLET_THRESHOLD_UACT = 5_000_000

async function runAkashCmd(args: string[]): Promise<string> {
  const env = getAkashEnv()
  return execAsync('akash', args, { env, timeout: AKASH_CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 })
}

interface EscrowStatus {
  dseq: string
  escrowBalanceUact: number
  pricePerBlockUact: number
  estimatedHoursRemaining: number
}

export class EscrowHealthMonitor {
  private cronJob: cron.ScheduledTask | null = null
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    if (this.cronJob) return

    this.cronJob = cron.schedule(BILLING_CONFIG.thresholds.checkIntervalCron, async () => {
      await this.checkAndRefill()
    })

    log.info(`Escrow health monitor started — checking at ${BILLING_CONFIG.thresholds.checkIntervalCron}`)
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
    }
  }

  async checkAndRefill(): Promise<void> {
    try {
      const activeDeployments = await this.prisma.akashDeployment.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          dseq: true,
          pricePerBlock: true,
          owner: true,
        },
      })

      if (activeDeployments.length === 0) return

      await this.checkWalletBalance()

      let refillCount = 0
      let errorCount = 0

      for (const dep of activeDeployments) {
        const dseq = dep.dseq.toString()
        if (!dseq || dseq === '0' || Number(dseq) < 0) continue

        try {
          const status = await this.getEscrowStatus(dseq, dep.owner, dep.pricePerBlock)
          if (!status) continue

          if (status.estimatedHoursRemaining < MIN_ESCROW_HOURS) {
            log.warn(
              { dseq, hoursRemaining: status.estimatedHoursRemaining },
              'Low on-chain escrow — attempting refill'
            )
            await this.refillEscrow(dseq, dep.owner, status.pricePerBlockUact)
            refillCount++
            // 8-second gap between on-chain TXs to avoid sequence collisions
            await new Promise(r => setTimeout(r, 8000))
          }
        } catch (err) {
          errorCount++
          log.error({ dseq, error: (err as Error).message }, 'Failed to check/refill escrow')
        }
      }

      if (refillCount > 0 || errorCount > 0) {
        log.info(
          { checked: activeDeployments.length, refilled: refillCount, errors: errorCount },
          'Escrow health check complete'
        )
      }
    } catch (err) {
      log.error(err as Error, 'Escrow health check failed')
    }
  }

  private async checkWalletBalance(): Promise<void> {
    try {
      const keyName = process.env.AKASH_KEY_NAME || 'default'
      const addrOutput = await runAkashCmd(['keys', 'show', keyName, '-a'])
      const address = addrOutput.trim()
      if (!address) {
        log.warn('Could not resolve deployer wallet address')
        return
      }

      const output = await runAkashCmd([
        'query', 'bank', 'balances', address,
        '-o', 'json',
      ])
      const data = JSON.parse(output)
      const uactBal = data?.balances?.find((b: { denom: string }) => b.denom === 'uact')
      const balance = parseInt(uactBal?.amount || '0', 10)
      if (balance < LOW_WALLET_THRESHOLD_UACT) {
        log.warn(
          { balanceUact: balance, balanceAct: (balance / 1_000_000).toFixed(4) },
          'CRITICAL: Deployer wallet ACT balance is low — escrow refills will fail soon'
        )
      }
    } catch {
      log.warn('Could not check deployer wallet balance')
    }
  }

  private async getEscrowStatus(
    dseq: string,
    owner: string,
    pricePerBlock: string | null
  ): Promise<EscrowStatus | null> {
    try {
      const output = await runAkashCmd([
        'query',
        'deployment',
        'get',
        '--owner', owner,
        '--dseq', dseq,
        '-o', 'json',
      ])

      const data = JSON.parse(output)
      const escrowAccount = data?.escrow_account
      if (!escrowAccount) return null

      // Akash CLI v2 returns escrow_account.state.funds[] and
      // escrow_account.state.state ('open' | 'closed'), NOT .balance.
      const escrowState = escrowAccount.state || escrowAccount
      if (escrowState.state === 'closed') return null

      const funds: Array<{ denom: string; amount: string }> = escrowState.funds || []
      const uactFund = funds.find((f: { denom: string }) => f.denom === 'uact')
      const balanceStr = uactFund?.amount
        // v1 fallback: escrow_account.balance.amount
        || escrowAccount.balance?.amount
        || '0'
      const escrowBalanceUact = Math.floor(parseFloat(balanceStr)) || 0

      const ppb = parseInt(pricePerBlock || '0', 10) || 1
      const blocksPerHour = 600
      const uactPerHour = ppb * blocksPerHour
      const estimatedHoursRemaining = uactPerHour > 0
        ? escrowBalanceUact / uactPerHour
        : Infinity

      log.debug(
        { dseq, escrowBalanceUact, estimatedHoursRemaining: +estimatedHoursRemaining.toFixed(2) },
        'Escrow status checked'
      )

      return {
        dseq,
        escrowBalanceUact,
        pricePerBlockUact: ppb,
        estimatedHoursRemaining,
      }
    } catch {
      return null
    }
  }

  private async refillEscrow(dseq: string, _owner: string, pricePerBlockUact: number): Promise<void> {
    const blocksPerHour = 600
    const refillUact = Math.max(
      100_000,
      pricePerBlockUact * blocksPerHour * REFILL_HOURS
    )

    try {
      const output = await runAkashCmd([
        'tx',
        'escrow',
        'deposit',
        'deployment',
        `${refillUact}uact`,
        '--dseq',
        dseq,
        '-y',
        '-o', 'json',
      ])

      let txhash = ''
      try {
        const result = JSON.parse(output)
        txhash = result.txhash || ''
        if (result.code && result.code !== 0) {
          throw new Error(`TX failed on-chain: code=${result.code} log=${result.raw_log || ''}`)
        }
      } catch (parseErr) {
        if ((parseErr as Error).message.startsWith('TX failed')) throw parseErr
      }

      log.info(
        { dseq, refillUact, refillAct: (refillUact / 1_000_000).toFixed(4), txhash },
        'Refilled on-chain escrow'
      )
    } catch (err) {
      log.error({ dseq, error: (err as Error).message }, 'Failed to refill escrow via CLI')
      throw err
    }
  }
}

let instance: EscrowHealthMonitor | null = null

export function getEscrowHealthMonitor(prisma: PrismaClient): EscrowHealthMonitor {
  if (!instance) {
    instance = new EscrowHealthMonitor(prisma)
  }
  return instance
}
