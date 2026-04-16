/**
 * Ops alert helper — emits a structured, log-level=error message that downstream
 * log aggregation (Discord/Sentry/Datadog) can ingest, and optionally POSTs to a
 * Discord webhook if OPS_ALERT_WEBHOOK_URL is configured.
 *
 * Uses per-process in-memory dedupe: the same `key` only fires once per
 * `suppressMs` window (default 10 minutes) so a cron that hits the same
 * failure every cycle doesn't spam the channel.
 *
 * Every call is fire-and-forget — we never throw from inside the alert path
 * (the caller is already handling a failure; making it worse is not useful).
 */

import { createLogger } from './logger.js'

const log = createLogger('ops-alert')

const DISCORD_COLOR_CRITICAL = 0xdc2626 // red-600
const DISCORD_COLOR_WARNING = 0xf59e0b // amber-500

const DEFAULT_SUPPRESS_MS = 10 * 60 * 1000

type Severity = 'critical' | 'warning'

export interface OpsAlertInput {
  /** Stable identifier used for dedupe. Same key within suppressMs only fires once. */
  key: string
  severity?: Severity
  title: string
  message: string
  context?: Record<string, unknown>
  /** Override dedupe window (ms). */
  suppressMs?: number
}

const lastFiredAt = new Map<string, number>()

export async function opsAlert(input: OpsAlertInput): Promise<void> {
  const now = Date.now()
  const suppressMs = input.suppressMs ?? DEFAULT_SUPPRESS_MS
  const last = lastFiredAt.get(input.key)
  if (last !== undefined && now - last < suppressMs) {
    // Still suppressed — emit a debug log so we can see that dedupe is working
    // without spamming the webhook.
    log.debug(
      { alertKey: input.key, suppressedForMs: suppressMs - (now - last) },
      'ops alert suppressed (dedupe window)'
    )
    return
  }
  lastFiredAt.set(input.key, now)

  const severity: Severity = input.severity ?? 'critical'

  // Structured log first — this is the primary signal. Includes `alert: true`
  // so downstream log processors can key off it even without the webhook.
  log.error(
    {
      alert: true,
      alertKey: input.key,
      severity,
      title: input.title,
      ...input.context,
    },
    `OPS ALERT: ${input.title} — ${input.message}`
  )

  // Optional: post to Discord webhook if configured.
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL
  if (!webhookUrl) return

  try {
    const color =
      severity === 'critical' ? DISCORD_COLOR_CRITICAL : DISCORD_COLOR_WARNING
    const emoji = severity === 'critical' ? '🚨' : '⚠️'
    const fields = input.context
      ? Object.entries(input.context)
          .slice(0, 10)
          .map(([name, value]) => ({
            name,
            value:
              typeof value === 'string'
                ? value.slice(0, 500)
                : String(JSON.stringify(value)).slice(0, 500),
            inline: false,
          }))
      : []

    const embed = {
      title: `${emoji} ${input.title}`,
      description:
        input.message.length > 2000
          ? input.message.slice(0, 1997) + '...'
          : input.message,
      color,
      fields,
      timestamp: new Date(now).toISOString(),
      footer: {
        text: `service-cloud-api · ${process.env.NODE_ENV ?? 'unknown'} · ${input.key}`,
      },
    }

    // 5s timeout — we never want the alert path to stall the caller.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
        signal: controller.signal,
      })
      if (!res.ok) {
        log.warn(
          { status: res.status, alertKey: input.key },
          'ops alert webhook returned non-2xx'
        )
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    // Never let the alert path itself fail loudly — the original error is
    // already surfaced via the structured log above.
    log.warn(
      { alertKey: input.key, err: (err as Error).message },
      'ops alert webhook failed'
    )
  }
}

/** Test helper — clears the dedupe cache. Not for production use. */
export function __resetOpsAlertDedupeForTesting(): void {
  lastFiredAt.clear()
}
