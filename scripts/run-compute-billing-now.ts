/**
 * Run Compute Billing Job Now
 *
 * Manually triggers the compute billing scheduler for testing.
 * Processes Akash escrow consumption, Phala hourly debits, and threshold checks.
 *
 * Usage:
 *   pnpm billing:run-now                    # Normal billing (skips pause check for safety)
 *   pnpm billing:run-now --force            # Bypass time guards + unique idempotency keys
 *   pnpm billing:run-now --with-pause       # Also run threshold/pause check (DANGEROUS in dev)
 *   pnpm billing:run-now --force --with-pause
 *
 * NOTE: Pause/threshold check is DISABLED by default in manual runs to prevent
 *       accidentally stopping production instances during testing.
 *       Use --with-pause to explicitly opt in.
 *
 * Requires: AUTH_SERVICE_URL, AUTH_INTROSPECTION_SECRET (for auth service internal API)
 */

import { PrismaClient } from '@prisma/client'
import { initInfisical } from '../src/config/infisical.js'

await initInfisical()
import { ComputeBillingScheduler } from '../src/services/billing/computeBillingScheduler.js'

const prisma = new PrismaClient()
const force = process.argv.includes('--force')
const withPause = process.argv.includes('--with-pause')

async function runComputeBillingNow() {
  console.log('🔄 Running compute billing job manually...\n')
  if (force) console.log('⚡ FORCE mode: bypassing time guards')
  if (!withPause) console.log('🛡️  Pause check DISABLED (use --with-pause to enable)')
  console.log('')

  const scheduler = new ComputeBillingScheduler(prisma)

  try {
    await scheduler.runNow({ force, noPause: !withPause })
    console.log('\n✅ Compute billing job completed')
  } catch (error) {
    console.error('\n❌ Compute billing job failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

runComputeBillingNow()
