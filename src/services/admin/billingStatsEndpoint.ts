/**
 * Internal endpoint: GET /internal/admin/billing-stats
 *
 * Returns aggregate billing stats per provider (Akash, Phala, Spheron):
 * total charged, raw cost, profit, active count, and current burn rate.
 * Secured by INTERNAL_AUTH_TOKEN.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { getAkashEnv } from '../../lib/akashEnv.js'
import { checkBalance } from '../providers/providerVerification.js'

const log = createLogger('admin-billing-stats')

interface AkashRow {
  total_charged_cents: bigint
  total_cost_cents: bigint
  active_count: bigint
  active_daily_burn_cents: bigint
}

interface PhalaRow {
  total_charged_cents: bigint
  total_cost_cents: bigint
  active_count: bigint
  active_hourly_burn_cents: bigint
}

interface SpheronRow {
  total_charged_cents: bigint
  total_cost_cents: bigint
  active_count: bigint
  active_hourly_burn_cents: bigint
}

interface WalletBalanceSnapshot {
  address: string
  uakt: number
  uact: number
  akt: number
  act: number
}

async function resolveAkashWalletAddress(): Promise<string> {
  const env = getAkashEnv({ skipMnemonicCheck: true })
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  return new Promise<string>((resolve, reject) => {
    execFile(
      'akash',
      ['keys', 'show', keyName, '-a'],
      { env, timeout: 15_000, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`akash keys show failed: ${(stderr || err.message).trim()}`))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

async function getAkashWalletSnapshot(): Promise<WalletBalanceSnapshot | null> {
  try {
    const [address, balance] = await Promise.all([
      resolveAkashWalletAddress(),
      checkBalance(),
    ])
    return {
      address,
      uakt: balance.uakt,
      uact: balance.uact,
      akt: balance.akt,
      act: balance.act,
    }
  } catch (error) {
    log.warn(
      { err: error, message: (error as Error)?.message },
      'Failed to read Akash wallet balance for admin stats',
    )
    return null
  }
}

export async function handleAdminBillingStats(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient,
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const [akashRows, phalaRows, spheronRows, akashWallet] = await Promise.all([
      prisma.$queryRaw<AkashRow[]>`
      SELECT
        COALESCE(SUM(e."consumed_cents"), 0)::bigint AS total_charged_cents,
        COALESCE(SUM(ROUND(e."consumed_cents" / (1.0 + e."margin_rate")))::bigint, 0) AS total_cost_cents,
        COUNT(DISTINCT CASE WHEN e."status" = 'ACTIVE' THEN e.id END)::bigint AS active_count,
        COALESCE(SUM(CASE WHEN e."status" = 'ACTIVE' THEN e."daily_rate_cents" ELSE 0 END), 0)::bigint AS active_daily_burn_cents
      FROM "deployment_escrow" e
    `,
      prisma.$queryRaw<PhalaRow[]>`
      SELECT
        COALESCE(SUM(pd."total_billed_cents"), 0)::bigint AS total_charged_cents,
        COALESCE(SUM(CASE WHEN pd."margin_rate" IS NOT NULL AND pd."margin_rate" > 0
          THEN ROUND(pd."total_billed_cents" / (1.0 + pd."margin_rate"))
          ELSE pd."total_billed_cents" END)::bigint, 0) AS total_cost_cents,
        COUNT(DISTINCT CASE WHEN pd."status" = 'ACTIVE' THEN pd.id END)::bigint AS active_count,
        COALESCE(SUM(CASE WHEN pd."status" = 'ACTIVE' THEN pd."hourly_rate_cents" ELSE 0 END), 0)::bigint AS active_hourly_burn_cents
      FROM "PhalaDeployment" pd
    `,
      prisma.$queryRaw<SpheronRow[]>`
      SELECT
        COALESCE(SUM(sd."total_billed_cents"), 0)::bigint AS total_charged_cents,
        COALESCE(SUM(CASE WHEN sd."margin_rate" IS NOT NULL AND sd."margin_rate" > 0
          THEN ROUND(sd."total_billed_cents" / (1.0 + sd."margin_rate"))
          ELSE sd."total_billed_cents" END)::bigint, 0) AS total_cost_cents,
        COUNT(DISTINCT CASE WHEN sd."status" = 'ACTIVE' THEN sd.id END)::bigint AS active_count,
        COALESCE(SUM(CASE WHEN sd."status" = 'ACTIVE' THEN sd."hourly_rate_cents" ELSE 0 END), 0)::bigint AS active_hourly_burn_cents
      FROM "SpheronDeployment" sd
    `,
      getAkashWalletSnapshot(),
    ])

    const akash = akashRows[0]
    const phala = phalaRows[0]
    const spheron = spheronRows[0]

    const akashCharged = Number(akash.total_charged_cents)
    const akashCost = Number(akash.total_cost_cents)
    const phalaCharged = Number(phala.total_charged_cents)
    const phalaCost = Number(phala.total_cost_cents)
    const spheronCharged = Number(spheron.total_charged_cents)
    const spheronCost = Number(spheron.total_cost_cents)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      akash: {
        totalChargedCents: akashCharged,
        totalCostCents: akashCost,
        profitCents: akashCharged - akashCost,
        activeCount: Number(akash.active_count),
        activeDailyBurnCents: Number(akash.active_daily_burn_cents),
        wallet: akashWallet,
      },
      phala: {
        totalChargedCents: phalaCharged,
        totalCostCents: phalaCost,
        profitCents: phalaCharged - phalaCost,
        activeCount: Number(phala.active_count),
        activeHourlyBurnCents: Number(phala.active_hourly_burn_cents),
        wallet: null,
      },
      spheron: {
        totalChargedCents: spheronCharged,
        totalCostCents: spheronCost,
        profitCents: spheronCharged - spheronCost,
        activeCount: Number(spheron.active_count),
        activeHourlyBurnCents: Number(spheron.active_hourly_burn_cents),
        wallet: null,
      },
    }))
  } catch (err) {
    log.error({ err }, 'Failed to fetch billing stats')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
