/**
 * Phase 44 / D1 smoke test — verifies the audit() helper actually persists.
 * Writes one event of each status, redacts a fake secret payload, reads the
 * rows back, and prints a summary.
 *
 * Run:
 *   cd service-cloud-api && npx tsx scripts/test-audit-smoke.ts
 */

import { PrismaClient } from '@prisma/client'
import { audit, withAudit, currentTraceId } from '../src/lib/audit.js'

async function main() {
  const prisma = new PrismaClient()

  const baseline = await prisma.auditEvent.count()
  console.log('Starting count:', baseline)

  const traceId = currentTraceId()
  console.log('Trace id for this smoke run:', traceId)

  // 1. Happy path.
  audit(prisma, {
    traceId,
    category: 'system',
    action: 'system.smoke_test',
    status: 'ok',
    payload: { hello: 'world', nested: { n: 1 } },
  })

  // 2. Error path with error fields + secret redaction.
  audit(prisma, {
    traceId,
    category: 'system',
    action: 'system.smoke_test',
    status: 'error',
    errorCode: 'E_SMOKE',
    errorMessage: 'simulated failure',
    payload: {
      password: 'hunter2',
      token: 'eyJabc',
      authorization: 'Bearer xyz',
      safe: 'keep-me',
    },
  })

  // 3. withAudit wraps an operation and auto-populates durationMs.
  await withAudit(
    prisma,
    { traceId, category: 'system', action: 'system.smoke_wrapped' },
    async () => {
      await new Promise((r) => setTimeout(r, 25))
    },
  )

  // Give the fire-and-forget writes a moment to flush.
  await new Promise((r) => setTimeout(r, 200))

  const rows = await prisma.auditEvent.findMany({
    where: { traceId },
    orderBy: { timestamp: 'asc' },
  })

  console.log(`\nRows written in this trace: ${rows.length}`)
  for (const r of rows) {
    console.log('─'.repeat(70))
    console.log(`  ${r.timestamp.toISOString()}  ${r.action}  [${r.status}]`)
    console.log(`    durationMs: ${r.durationMs ?? '—'}`)
    console.log(`    errorCode/message: ${r.errorCode ?? '—'} / ${r.errorMessage ?? '—'}`)
    console.log(`    payload: ${JSON.stringify(r.payload)}`)
  }

  const after = await prisma.auditEvent.count()
  console.log(`\nTotal rows: ${baseline} → ${after}  (delta: ${after - baseline})`)

  // Cleanup — leave table clean after the smoke test.
  await prisma.auditEvent.deleteMany({ where: { traceId } })
  console.log('Cleanup: removed smoke-test rows.')

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Smoke test failed:', err)
  process.exitCode = 1
})
