/**
 * Backfill Compute Billing for Existing Deployments
 *
 * Adds billing records to Akash/Phala deployments that were created
 * before the billing integration was added.
 *
 * Akash:  Creates DeploymentEscrow records using the bid's pricePerBlock
 * Phala:  Populates hourlyRateCents, marginRate, orgBillingId, etc.
 *
 * Safe to run multiple times (idempotent — skips deployments that already have billing data).
 *
 * Usage:
 *   pnpm tsx scripts/backfill-compute-billing.ts [--dry-run]
 */

import { PrismaClient } from '@prisma/client'
import { initInfisical } from '../src/config/infisical.js'

await initInfisical()

import { getBillingApiClient } from '../src/services/billing/billingApiClient.js'
import { getPhalaHourlyRate, applyMargin, akashPricePerBlockToUsdPerDay } from '../src/config/pricing.js'

const prisma = new PrismaClient()
const billingApi = getBillingApiClient()
const DRY_RUN = process.argv.includes('--dry-run')

if (DRY_RUN) {
  console.log('🏜️  DRY RUN — no changes will be made\n')
}

async function backfillAkashEscrows() {
  console.log('━━━ Akash Deployment Escrow Backfill ━━━\n')

  // Find ACTIVE Akash deployments that DON'T have an escrow record
  const deployments = await prisma.akashDeployment.findMany({
    where: {
      status: 'ACTIVE',
      escrow: null, // no existing escrow
    },
    include: {
      service: {
        include: {
          project: true,
        },
      },
    },
  })

  console.log(`Found ${deployments.length} active Akash deployments without escrow\n`)

  let created = 0
  let skipped = 0
  let errored = 0

  for (const deployment of deployments) {
    const orgId = deployment.service.project.organizationId

    if (!orgId) {
      console.log(`  ⏭  ${deployment.id} (dseq=${deployment.dseq}): no organizationId on project — skipping`)
      skipped++
      continue
    }

    if (!deployment.pricePerBlock) {
      console.log(`  ⏭  ${deployment.id} (dseq=${deployment.dseq}): no pricePerBlock — skipping`)
      skipped++
      continue
    }

    try {
      // Resolve org billing from auth service
      const orgBilling = await billingApi.getOrgBilling(orgId)
      const orgMarkup = await billingApi.getOrgMarkup(orgBilling.orgBillingId)

      // Calculate daily cost with margin
      const rawDailyUsd = akashPricePerBlockToUsdPerDay(deployment.pricePerBlock)
      const chargedDailyUsd = applyMargin(rawDailyUsd, orgMarkup.marginRate)
      const dailyRateCents = Math.ceil(chargedDailyUsd * 100)

      // Estimate how many days this deployment has been active
      const activeSince = deployment.createdAt
      const daysSinceCreation = Math.max(1, Math.floor((Date.now() - activeSince.getTime()) / (1000 * 60 * 60 * 24)))
      const estimatedConsumedCents = dailyRateCents * daysSinceCreation

      // Deposit = consumed so far (no actual wallet debit for historical usage)
      const depositCents = estimatedConsumedCents

      console.log(
        `  📋 ${deployment.id} (dseq=${deployment.dseq}):\n` +
        `     org=${orgId}, pricePerBlock=${deployment.pricePerBlock}\n` +
        `     rawDaily=$${rawDailyUsd.toFixed(4)}, chargedDaily=$${(dailyRateCents / 100).toFixed(2)} (margin=${(orgMarkup.marginRate * 100).toFixed(0)}%)\n` +
        `     activeDays=${daysSinceCreation}, estimatedConsumed=$${(estimatedConsumedCents / 100).toFixed(2)}`
      )

      if (!DRY_RUN) {
        await prisma.deploymentEscrow.create({
          data: {
            akashDeploymentId: deployment.id,
            orgBillingId: orgBilling.orgBillingId,
            organizationId: orgId,
            depositCents,
            consumedCents: estimatedConsumedCents,
            dailyRateCents,
            marginRate: orgMarkup.marginRate,
            status: 'ACTIVE',
            lastBilledAt: new Date(), // Reset billing clock to now
          },
        })
        console.log(`     ✅ Created escrow record`)
      } else {
        console.log(`     🏜️  Would create escrow record (dry run)`)
      }

      created++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`  ❌ ${deployment.id} (dseq=${deployment.dseq}): ${msg}`)
      errored++
    }
  }

  console.log(`\nAkash summary: ${created} created, ${skipped} skipped, ${errored} errored\n`)
}

async function backfillPhalaDeployments() {
  console.log('━━━ Phala Deployment Billing Backfill ━━━\n')

  // Find ACTIVE Phala deployments that DON'T have billing fields populated
  const deployments = await prisma.phalaDeployment.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { orgBillingId: null },
        { hourlyRateCents: null },
      ],
    },
    include: {
      service: {
        include: {
          project: true,
        },
      },
    },
  })

  console.log(`Found ${deployments.length} active Phala deployments without billing fields\n`)

  let updated = 0
  let skipped = 0
  let errored = 0

  for (const deployment of deployments) {
    const orgId = deployment.service.project.organizationId

    if (!orgId) {
      console.log(`  ⏭  ${deployment.id} (${deployment.name}): no organizationId on project — skipping`)
      skipped++
      continue
    }

    try {
      // Resolve org billing from auth service
      const orgBilling = await billingApi.getOrgBilling(orgId)
      const orgMarkup = await billingApi.getOrgMarkup(orgBilling.orgBillingId)

      // Calculate hourly rate with margin
      const cvmSize = deployment.cvmSize || 'tdx.large'
      const rawHourlyRate = getPhalaHourlyRate(cvmSize)
      const chargedHourlyRate = applyMargin(rawHourlyRate, orgMarkup.marginRate)
      const hourlyRateCents = Math.ceil(chargedHourlyRate * 100)

      console.log(
        `  📋 ${deployment.id} (${deployment.name}):\n` +
        `     org=${orgId}, cvmSize=${cvmSize}\n` +
        `     rawHourly=$${rawHourlyRate.toFixed(4)}, chargedHourly=$${(hourlyRateCents / 100).toFixed(2)} (margin=${(orgMarkup.marginRate * 100).toFixed(0)}%)`
      )

      if (!DRY_RUN) {
        await prisma.phalaDeployment.update({
          where: { id: deployment.id },
          data: {
            orgBillingId: orgBilling.orgBillingId,
            organizationId: orgId,
            marginRate: orgMarkup.marginRate,
            hourlyRateCents,
            cvmSize,
            activeStartedAt: deployment.activeStartedAt || deployment.createdAt,
            lastBilledAt: new Date(), // Reset billing clock to now
          },
        })
        console.log(`     ✅ Updated billing fields`)
      } else {
        console.log(`     🏜️  Would update billing fields (dry run)`)
      }

      updated++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`  ❌ ${deployment.id} (${deployment.name}): ${msg}`)
      errored++
    }
  }

  console.log(`\nPhala summary: ${updated} updated, ${skipped} skipped, ${errored} errored\n`)
}

async function main() {
  console.log('🔧 Compute Billing Backfill\n')
  console.log('This script populates billing records for existing deployments')
  console.log('that were created before the billing integration was added.\n')

  try {
    await backfillAkashEscrows()
    await backfillPhalaDeployments()
    console.log('✅ Backfill complete')
  } catch (error) {
    console.error('❌ Backfill failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

main()
