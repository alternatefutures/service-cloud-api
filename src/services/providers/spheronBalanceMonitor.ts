/**
 * Spheron team-balance monitor.
 *
 * Periodically (default 10min) polls `GET /api/balance` and pages ops if
 * the balance falls below `SPHERON_MIN_BALANCE_USD` (default $50). The
 * Spheron platform team is the **single source of truth for ALL user
 * deployments** — when it runs dry, every Spheron deploy across the fleet
 * fails with "insufficient balance". This monitor exists to catch that
 * before users do.
 *
 * Architecture mirrors `EscrowHealthMonitor` (the Akash equivalent):
 *
 *   - Per-pod work, but currently un-leadered: the Spheron API is
 *     read-only here so duplicate alerts are fine. Add `runWithLeadership`
 *     wrap when scaling cloud-api to N>1 if you want to dedupe further
 *     (opsAlert's per-key suppress already prevents log/Discord spam).
 *   - opsAlert keys: `spheron-low-balance` (warning) and
 *     `spheron-team-missing` (critical). Each suppressed for 55 min so
 *     a real outage paginates the channel ~once an hour, not every cycle.
 *   - 10s timeout on the check via the SpheronClient's own request
 *     timeout — the monitor never blocks shutdown for more than 10s.
 *
 * Locked decision (per AF_HANDOFF — Spheron Phase A):
 *   - The threshold is configurable via `SPHERON_MIN_BALANCE_USD`. Default
 *     50 USD chosen as ~5x the cheapest hour-of-deploy + a comfortable
 *     buffer for parallel user deploys.
 *   - The team id we monitor comes from `SPHERON_TEAM_ID`; if that env
 *     is unset the monitor falls back to the API's `isCurrentTeam` flag.
 *     Either way, "team not found at all" → critical alert.
 */

import type { PrismaClient } from '@prisma/client'
import { getSpheronClient } from '../spheron/client.js'
import { opsAlert } from '../../lib/opsAlert.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('spheron-balance-monitor')

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000  // 10 min
const DEFAULT_THRESHOLD_USD = 50
const ALERT_SUPPRESS_MS = 55 * 60 * 1000     // 55 min — re-page roughly hourly

export class SpheronBalanceMonitor {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly prisma: PrismaClient
  private readonly intervalMs: number
  private readonly thresholdUsd: number

  constructor(prisma: PrismaClient, opts?: { intervalMs?: number; thresholdUsd?: number }) {
    this.prisma = prisma
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
    const envThreshold = Number(process.env.SPHERON_MIN_BALANCE_USD)
    this.thresholdUsd = opts?.thresholdUsd ?? (Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : DEFAULT_THRESHOLD_USD)
  }

  start(): void {
    if (this.timer) return

    const client = getSpheronClient()
    if (!client) {
      log.info('Spheron not configured — balance monitor disabled')
      return
    }

    // Run once immediately so a freshly-deployed pod surfaces the
    // current balance in the first 10s, not after the first interval.
    this.runOnce().catch(err => {
      log.warn({ err }, 'Spheron balance monitor: initial check failed')
    })

    this.timer = setInterval(() => {
      this.runOnce().catch(err => {
        log.warn({ err }, 'Spheron balance monitor: cycle failed')
      })
    }, this.intervalMs)

    log.info(
      { intervalMs: this.intervalMs, thresholdUsd: this.thresholdUsd },
      'Spheron balance monitor started',
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Test/ops hook — exposed so an admin endpoint can poke the check
   * without waiting for the next interval.
   */
  async runOnce(): Promise<void> {
    if (this.running) {
      log.warn('Spheron balance monitor: previous cycle still running, skipping')
      return
    }
    this.running = true

    try {
      const client = getSpheronClient()
      if (!client) return

      const team = await client.getCurrentTeamBalance()
      if (!team) {
        await opsAlert({
          key: 'spheron-team-missing',
          severity: 'critical',
          title: 'Spheron team not accessible via current API key',
          message:
            `getCurrentTeamBalance returned null. The configured SPHERON_TEAM_ID ` +
            `(or the API key's default team) is no longer accessible. Spheron deploys ` +
            `will fail until this is resolved. Verify the API key is valid and the ` +
            `team membership hasn't been revoked.`,
          context: {
            teamIdEnv: process.env.SPHERON_TEAM_ID ?? null,
          },
          suppressMs: ALERT_SUPPRESS_MS,
        })
        return
      }

      log.info(
        { teamId: team.teamId, teamName: team.teamName, balance: team.balance, thresholdUsd: this.thresholdUsd },
        'Spheron team balance checked',
      )

      if (team.balance < this.thresholdUsd) {
        await opsAlert({
          key: 'spheron-low-balance',
          severity: 'warning',
          title: 'Spheron team balance is low',
          message:
            `Team "${team.teamName}" balance is $${team.balance.toFixed(2)} USD, ` +
            `below the $${this.thresholdUsd.toFixed(2)} threshold. New Spheron deploys will ` +
            `start failing once the balance reaches zero. Top up the team via the Spheron ` +
            `dashboard.`,
          context: {
            teamId: team.teamId,
            teamName: team.teamName,
            balanceUsd: team.balance,
            thresholdUsd: this.thresholdUsd,
          },
          suppressMs: ALERT_SUPPRESS_MS,
        })
      }
    } catch (err) {
      // Don't opsAlert on the API itself failing transiently — that
      // would generate a hot loop of "API call failed" alerts. The
      // structured warn log is enough; if it persists, it'll show up in
      // log aggregation.
      log.warn({ err }, 'Spheron balance check failed (transient or auth issue)')
    } finally {
      this.running = false
    }
  }
}
