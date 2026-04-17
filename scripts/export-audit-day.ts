/**
 * Manual / backfill audit export.
 *
 * Usage:
 *   npx tsx scripts/export-audit-day.ts 2026-04-16
 *   npx tsx scripts/export-audit-day.ts 2026-04-16 2026-04-20   # inclusive range
 *
 * - Writes one JSONL file per UTC day to `AUDIT_EXPORT_DIR` (default
 *   `./audit-exports/YYYY/MM/YYYY-MM-DD.jsonl`).
 * - Idempotent — re-running a date overwrites atomically.
 * - Pulls from BOTH `service-auth` (via internal HTTP) and
 *   `service-cloud-api` Postgres directly. Requires
 *   `AUTH_INTROSPECTION_SECRET` and `AUTH_SERVICE_URL` to fetch the
 *   auth half; without them, exports the cloud-api half only and
 *   warns.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { requestContext } from '../src/lib/requestContext.js'
import { exportAuditDay } from '../src/services/audit/auditExporter.js'

const prisma = new PrismaClient()

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.length > 2) {
    console.error('Usage: npx tsx scripts/export-audit-day.ts YYYY-MM-DD [YYYY-MM-DD]')
    process.exit(2)
  }

  const fromIso = args[0]
  const toIso = args[1] ?? args[0]

  const dates = enumerateDays(fromIso, toIso)
  console.log(`Exporting ${dates.length} day(s): ${dates[0]} → ${dates[dates.length - 1]}`)

  let okCount = 0
  let failCount = 0
  for (const d of dates) {
    const traceId = randomUUID()
    try {
      const result = await requestContext.run(
        { requestId: traceId, traceId },
        () => exportAuditDay(prisma, d),
      )
      console.log(
        `  ✓ ${d}  rows=${result.totalCount} (cloud=${result.cloudApiCount} auth=${result.authCount})  ` +
          `bytes=${result.bytes}  ${result.durationMs}ms  → ${result.filePath}`,
      )
      okCount++
    } catch (err) {
      console.error(`  ✗ ${d}  FAILED: ${(err as Error).message}`)
      failCount++
    }
  }

  console.log(`\nDone. ok=${okCount} fail=${failCount}`)
  if (failCount > 0) process.exit(1)
}

function enumerateDays(fromIso: string, toIso: string): string[] {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromIso)
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toIso)
  if (!m1 || !m2) throw new Error(`Bad date arg — expected YYYY-MM-DD`)
  const start = Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]))
  const end = Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]))
  if (end < start) throw new Error(`to-date is before from-date`)
  const out: string[] = []
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    const d = new Date(t)
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    )
  }
  return out
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
