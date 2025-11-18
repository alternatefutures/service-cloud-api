/**
 * Generate Sample Invoice PDF
 *
 * Quick script to generate an example invoice PDF to preview the branding
 */

import { PrismaClient } from '@prisma/client'
import { InvoiceService } from '../src/services/billing/invoiceService.js'

const prisma = new PrismaClient()

async function generateSampleInvoice() {
  console.log('🎨 Generating sample invoice PDF...\n')

  try {
    const invoiceService = new InvoiceService(prisma)

    // Find or create test customer
    let customer = await prisma.customer.findFirst({
      where: { email: 'demo@example.com' },
      include: { user: true },
    })

    if (!customer) {
      console.log('Creating test customer...')
      const user = await prisma.user.create({
        data: {
          email: 'demo@example.com',
          username: 'demo-user',
          walletAddress: '0xdemo123456789',
        },
      })

      customer = await prisma.customer.create({
        data: {
          userId: user.id,
          email: 'demo@example.com',
          name: 'Acme Corporation',
        },
      })
    }

    // Find or create test subscription
    let subscription = await prisma.subscription.findFirst({
      where: { customerId: customer.id, status: 'ACTIVE' },
    })

    if (!subscription) {
      console.log('Creating test subscription...')
      const now = new Date()
      const periodEnd = new Date(now)
      periodEnd.setMonth(periodEnd.getMonth() + 1)

      subscription = await prisma.subscription.create({
        data: {
          customerId: customer.id,
          status: 'ACTIVE',
          plan: 'PRO',
          basePricePerSeat: 4900, // $49.00
          usageMarkup: 0.2, // 20%
          seats: 3,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      })
    }

    // Create test usage records
    console.log('Creating test usage records...')
    const now = new Date()

    await prisma.usageRecord.createMany({
      data: [
        {
          customerId: customer.id,
          type: 'BANDWIDTH',
          resourceType: 'AGGREGATED',
          quantity: 125.5,
          unit: 'GB',
          unitPrice: 10,
          amount: 1255,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          timestamp: now,
        },
        {
          customerId: customer.id,
          type: 'COMPUTE',
          resourceType: 'AGGREGATED',
          quantity: 42.25,
          unit: 'HOURS',
          unitPrice: 15,
          amount: 634,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          timestamp: now,
        },
        {
          customerId: customer.id,
          type: 'REQUESTS',
          resourceType: 'AGGREGATED',
          quantity: 250000,
          unit: 'REQUESTS',
          unitPrice: 50,
          amount: 12500,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          timestamp: now,
        },
      ],
    })

    // Generate invoice
    console.log('Generating invoice...')
    const invoiceId = await invoiceService.generateInvoice(subscription.id)

    // Generate PDF
    console.log('Generating PDF...')
    const pdfPath = await invoiceService.generatePDF(invoiceId)

    console.log('\n✅ Sample invoice PDF generated successfully!')
    console.log(`📄 Location: ${pdfPath}`)
    console.log('\nYou can open it with:')
    console.log(`   open "${pdfPath}"`)
    console.log('\nInvoice details:')

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true },
    })

    console.log(`   Invoice #: ${invoice?.invoiceNumber}`)
    console.log(`   Customer: ${customer.name}`)
    console.log(`   Total: $${((invoice?.total || 0) / 100).toFixed(2)}`)
    console.log(`   Line items: ${invoice?.lineItems.length}`)
  } catch (error) {
    console.error('❌ Error generating sample invoice:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

generateSampleInvoice()
