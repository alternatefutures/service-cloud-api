/**
 * Invoice Generation Service
 *
 * Generates and manages invoices with:
 *   - Platform section (seat charge + trial discount)
 *   - Compute & Storage Ledger (running balance)
 *   - Akash Escrow Detail (per-deployment)
 *   - Summary footer (wallet + escrow = total value)
 */

import type { PrismaClient } from '@prisma/client'
import PDFDocument from 'pdfkit'
// @ts-ignore - svg-to-pdfkit doesn't have type declarations
import SVGtoPDF from 'svg-to-pdfkit'
import { writeFileSync, readFileSync, createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import { getBillingApiClient } from './billingApiClient.js'

/** Compute ledger entry for invoice detail */
interface ComputeLedgerEntry {
  date: string
  description: string
  provider: string
  debitCents: number
  creditCents: number
  balanceCents: number
}

/** Escrow detail line for invoice */
interface EscrowDetail {
  deploymentId: string
  dseq: string
  depositedCents: number
  consumedCents: number
  remainingCents: number
  dailyRateCents: number
  status: string
}

export class InvoiceService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Generate invoice for subscription period
   */
  async generateInvoice(subscriptionId: string): Promise<string> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        customer: {
          include: { user: true },
        },
        plan: true,
      },
    })

    if (!subscription) {
      throw new Error('Subscription not found')
    }

    // Get usage for the period
    const usage = await this.prisma.usageRecord.groupBy({
      by: ['type'],
      where: {
        customerId: subscription.customerId,
        periodStart: { gte: subscription.currentPeriodStart },
        periodEnd: { lte: subscription.currentPeriodEnd },
      },
      _sum: {
        quantity: true,
        amount: true,
      },
    })

    // Calculate amounts
    const baseAmount =
      Number(subscription.plan.basePricePerSeat) * subscription.seats
    let usageAmount = 0

    for (const item of usage) {
      usageAmount += item._sum?.amount || 0
    }

    // Apply usage markup
    const usageMarkup = Number(subscription.plan.usageMarkup)
    const markedUpUsage = Math.ceil(usageAmount * (1 + usageMarkup))

    const subtotal = baseAmount + markedUpUsage

    // Get tax rate
    const settings = await this.prisma.billingSettings.findFirst()
    const taxRate = Number(settings?.taxRatePercent || 0)
    const tax = Math.ceil(subtotal * taxRate)

    const total = subtotal + tax

    // Generate invoice number
    const invoiceNumber = `INV-${Date.now()}-${Math.random().toString(36).substring(7)}`

    // Calculate due date
    const dueDate = new Date(subscription.currentPeriodEnd)
    dueDate.setDate(dueDate.getDate() + (settings?.invoiceDueDays || 30))

    // Create invoice
    const invoice = await this.prisma.invoice.create({
      data: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        invoiceNumber,
        status: 'OPEN',
        subtotal,
        tax,
        total,
        amountDue: total,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        dueDate,
      },
    })

    // Create line items
    // Base subscription
    await this.prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        description: `${subscription.plan.name} Plan - ${subscription.seats} seat(s)`,
        quantity: subscription.seats,
        unitPrice: Number(subscription.plan.basePricePerSeat),
        amount: baseAmount,
      },
    })

    // Usage line items
    for (const item of usage) {
      const quantity = Number(item._sum?.quantity || 0)
      const amount = item._sum?.amount || 0
      const markedUp = Math.ceil(amount * (1 + usageMarkup))

      await this.prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          description: `${item.type} Usage`,
          quantity,
          unitPrice:
            amount > 0 ? Math.ceil((amount / quantity) * 100) / 100 : 0,
          amount: markedUp,
          metadata: { type: item.type },
        },
      })
    }

    // Add compute line items (Akash + Phala) for the billing period
    try {
      await this.addComputeLineItems(invoice.id, subscription.customerId, subscription.currentPeriodStart, subscription.currentPeriodEnd)
    } catch (error) {
      console.warn(`[InvoiceService] Failed to add compute line items for invoice ${invoice.id}:`, error)
    }

    return invoice.id
  }

  /**
   * Add compute-specific line items (Akash escrow consumption, Phala hourly)
   */
  private async addComputeLineItems(
    invoiceId: string,
    customerId: string,
    periodStart: Date,
    periodEnd: Date
  ) {
    // Akash escrow consumption in the period
    const akashEscrows = await this.prisma.deploymentEscrow.findMany({
      where: {
        createdAt: { lte: periodEnd },
        OR: [
          { status: 'ACTIVE', lastBilledAt: { gte: periodStart } },
          { status: 'REFUNDED', updatedAt: { gte: periodStart } },
          { status: 'DEPLETED', updatedAt: { gte: periodStart } },
          { status: 'PAUSED', updatedAt: { gte: periodStart } },
        ],
      },
      include: {
        akashDeployment: { select: { dseq: true, provider: true, sdlContent: true } },
      },
    })

    for (const escrow of akashEscrows) {
      const dseq = escrow.akashDeployment?.dseq?.toString() || 'unknown'
      const consumed = escrow.consumedCents
      if (consumed > 0) {
        await this.prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            description: `Akash Compute (dseq: ${dseq}) — daily consumption`,
            quantity: Math.ceil(consumed / Math.max(1, escrow.dailyRateCents)), // approx days
            unitPrice: escrow.dailyRateCents,
            amount: consumed,
            metadata: {
              type: 'AKASH_COMPUTE',
              dseq,
              provider: escrow.akashDeployment?.provider,
              escrowId: escrow.id,
            },
          },
        })
      }
    }

    // Phala hourly charges in the period
    const phalaDeployments = await this.prisma.phalaDeployment.findMany({
      where: {
        totalBilledCents: { gt: 0 },
        OR: [
          { status: 'ACTIVE', lastBilledAt: { gte: periodStart } },
          { status: 'STOPPED', updatedAt: { gte: periodStart } },
          { status: 'DELETED', updatedAt: { gte: periodStart } },
        ],
      },
    })

    for (const deployment of phalaDeployments) {
      if (deployment.totalBilledCents > 0 && deployment.hourlyRateCents) {
        const hours = Math.ceil(deployment.totalBilledCents / deployment.hourlyRateCents)
        await this.prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            description: `Phala TEE (${deployment.cvmSize || 'tdx.large'}: ${deployment.name})`,
            quantity: hours,
            unitPrice: deployment.hourlyRateCents,
            amount: deployment.totalBilledCents,
            metadata: {
              type: 'PHALA_TEE',
              cvmSize: deployment.cvmSize,
              appId: deployment.appId,
              deploymentId: deployment.id,
            },
          },
        })
      }
    }
  }

  /**
   * Generate PDF for invoice
   */
  async generatePDF(invoiceId: string): Promise<string> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: {
          include: { user: true },
        },
        subscription: true,
        lineItems: true,
      },
    })

    if (!invoice) {
      throw new Error('Invoice not found')
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50 })

    // Register Instrument Sans font (from home page)
    const fontsDir = join(process.cwd(), 'assets', 'fonts')
    doc.registerFont(
      'Instrument Sans',
      join(fontsDir, 'InstrumentSans-Regular.ttf')
    )
    doc.registerFont(
      'Instrument Sans Medium',
      join(fontsDir, 'InstrumentSans-Medium.ttf')
    )
    doc.registerFont(
      'Instrument Sans SemiBold',
      join(fontsDir, 'InstrumentSans-SemiBold.ttf')
    )

    // Load and add logo
    const logoPath = join(process.cwd(), 'assets', 'logo.svg')
    const logoSVG = readFileSync(logoPath, 'utf-8')

    // Add logo (AF logo from home page)
    SVGtoPDF(doc, logoSVG, 50, 40, { width: 50, height: 45 })

    // Company name and info
    doc
      .font('Instrument Sans SemiBold')
      .fontSize(16)
      .fillColor('#0026ff')
      .text('Alternate Futures', 110, 50)
      .font('Instrument Sans')
      .fontSize(9)
      .fillColor('#666666')
      .text('alternatefutures.ai', 110, 70)

    // Invoice title and info (right side)
    doc
      .font('Instrument Sans SemiBold')
      .fontSize(24)
      .fillColor('#000000')
      .text('INVOICE', 400, 50, { align: 'right' })
      .font('Instrument Sans')
      .fontSize(10)
      .fillColor('#666666')
      .text(`Invoice #: ${invoice.invoiceNumber}`, 350, 80, { align: 'right' })
      .text(`Date: ${invoice.createdAt.toLocaleDateString()}`, 350, 95, {
        align: 'right',
      })
      .text(
        `Due Date: ${invoice.dueDate?.toLocaleDateString() || 'N/A'}`,
        350,
        110,
        { align: 'right' }
      )

    // Horizontal line after header
    doc.moveTo(50, 130).lineTo(550, 130).strokeColor('#e0e0e0').stroke()

    // Customer info
    doc
      .font('Instrument Sans SemiBold')
      .fontSize(10)
      .fillColor('#666666')
      .text('BILL TO:', 50, 150)
      .font('Instrument Sans Medium')
      .fontSize(12)
      .fillColor('#000000')
      .text(invoice.customer.name || 'N/A', 50, 165)
      .font('Instrument Sans')
      .fontSize(10)
      .fillColor('#666666')
      .text(invoice.customer.email || 'N/A', 50, 180)

    // Line items table
    let y = 220

    // Table header with background
    doc.rect(50, y - 5, 500, 20).fillAndStroke('#f5f5f5', '#e0e0e0')

    doc
      .font('Instrument Sans SemiBold')
      .fontSize(10)
      .fillColor('#000000')
      .text('Description', 55, y)
      .text('Quantity', 280, y)
      .text('Unit Price', 350, y)
      .text('Amount', 450, y)

    y += 25
    for (const item of invoice.lineItems) {
      doc
        .font('Instrument Sans')
        .fillColor('#000000')
        .text(item.description, 55, y)
        .text(item.quantity.toString(), 280, y)
        .text(`$${(item.unitPrice / 100).toFixed(2)}`, 350, y)
        .text(`$${(item.amount / 100).toFixed(2)}`, 450, y)
      y += 20

      // Add subtle line between items
      doc
        .moveTo(50, y - 2)
        .lineTo(550, y - 2)
        .strokeColor('#f0f0f0')
        .stroke()
    }

    // Totals section
    y += 10
    doc.moveTo(50, y).lineTo(550, y).strokeColor('#e0e0e0').stroke()
    y += 20

    doc
      .font('Instrument Sans')
      .fontSize(10)
      .fillColor('#666666')
      .text('Subtotal:', 350, y)
      .fillColor('#000000')
      .text(`$${(invoice.subtotal / 100).toFixed(2)}`, 450, y)
    y += 20

    doc
      .fillColor('#666666')
      .text('Tax:', 350, y)
      .fillColor('#000000')
      .text(`$${(invoice.tax / 100).toFixed(2)}`, 450, y)
    y += 25

    // Total with highlight
    doc.rect(340, y - 5, 210, 25).fillAndStroke('#f8f9fa', '#e0e0e0')

    doc
      .font('Instrument Sans SemiBold')
      .fontSize(13)
      .fillColor('#000000')
      .text('Total:', 350, y)
      .font('Instrument Sans SemiBold')
      .fontSize(14)
      .fillColor('#0026ff')
      .text(`$${(invoice.total / 100).toFixed(2)}`, 450, y)

    // ========================================
    // AKASH ESCROW DETAIL SECTION
    // ========================================

    const escrowLineItems = invoice.lineItems.filter(
      (li) => (li.metadata as any)?.type === 'AKASH_COMPUTE'
    )

    if (escrowLineItems.length > 0) {
      y += 50

      // Check if we need a new page
      if (y > 650) {
        doc.addPage()
        y = 50
      }

      doc
        .font('Instrument Sans SemiBold')
        .fontSize(12)
        .fillColor('#000000')
        .text('Akash Escrow Detail', 50, y)

      y += 20

      // Escrow table header
      doc.rect(50, y - 5, 500, 20).fillAndStroke('#f5f5f5', '#e0e0e0')
      doc
        .font('Instrument Sans SemiBold')
        .fontSize(9)
        .fillColor('#000000')
        .text('Deployment', 55, y)
        .text('Daily Rate', 200, y)
        .text('Consumed', 290, y)
        .text('Status', 380, y)
        .text('Net Cost', 450, y)

      y += 20

      for (const item of escrowLineItems) {
        const meta = item.metadata as any
        doc
          .font('Instrument Sans')
          .fontSize(9)
          .fillColor('#000000')
          .text(`dseq: ${meta?.dseq || 'N/A'}`, 55, y)
          .text(`$${(item.unitPrice / 100).toFixed(2)}/day`, 200, y)
          .text(`$${(item.amount / 100).toFixed(2)}`, 290, y)
          .text(meta?.status || 'ACTIVE', 380, y)
          .text(`$${(item.amount / 100).toFixed(2)}`, 450, y)
        y += 18
      }
    }

    // ========================================
    // PHALA TEE DETAIL SECTION
    // ========================================

    const phalaLineItems = invoice.lineItems.filter(
      (li) => (li.metadata as any)?.type === 'PHALA_TEE'
    )

    if (phalaLineItems.length > 0) {
      y += 30

      if (y > 650) {
        doc.addPage()
        y = 50
      }

      doc
        .font('Instrument Sans SemiBold')
        .fontSize(12)
        .fillColor('#000000')
        .text('Phala TEE Detail', 50, y)

      y += 20

      doc.rect(50, y - 5, 500, 20).fillAndStroke('#f5f5f5', '#e0e0e0')
      doc
        .font('Instrument Sans SemiBold')
        .fontSize(9)
        .fillColor('#000000')
        .text('CVM', 55, y)
        .text('Size', 200, y)
        .text('Hours', 290, y)
        .text('Rate', 360, y)
        .text('Total', 450, y)

      y += 20

      for (const item of phalaLineItems) {
        const meta = item.metadata as any
        doc
          .font('Instrument Sans')
          .fontSize(9)
          .fillColor('#000000')
          .text(item.description.slice(0, 35), 55, y)
          .text(meta?.cvmSize || 'tdx.large', 200, y)
          .text(`${item.quantity}`, 290, y)
          .text(`$${(item.unitPrice / 100).toFixed(2)}/hr`, 360, y)
          .text(`$${(item.amount / 100).toFixed(2)}`, 450, y)
        y += 18
      }
    }

    // ========================================
    // SUMMARY FOOTER
    // ========================================

    y += 40

    if (y > 650) {
      doc.addPage()
      y = 50
    }

    // Get current wallet balance and escrow totals
    try {
      const activeEscrows = await this.prisma.deploymentEscrow.findMany({
        where: { status: 'ACTIVE' },
      })

      const totalEscrowCents = activeEscrows.reduce(
        (sum, e) => sum + (e.depositCents - e.consumedCents),
        0
      )

      const totalDailyCostCents = activeEscrows.reduce(
        (sum, e) => sum + e.dailyRateCents,
        0
      )

      const phalaActive = await this.prisma.phalaDeployment.findMany({
        where: { status: 'ACTIVE', hourlyRateCents: { not: null } },
      })

      const phalaDailyCostCents = phalaActive.reduce(
        (sum, p) => sum + (p.hourlyRateCents || 0) * 24,
        0
      )

      const combinedDailyCents = totalDailyCostCents + phalaDailyCostCents

      // Summary box
      doc.rect(50, y - 10, 500, 80).fillAndStroke('#f8f9fa', '#e0e0e0')

      doc
        .font('Instrument Sans SemiBold')
        .fontSize(11)
        .fillColor('#000000')
        .text('Account Summary', 60, y)

      y += 18

      doc
        .font('Instrument Sans')
        .fontSize(9)
        .fillColor('#666666')
        .text('In Akash Escrow:', 60, y)
        .fillColor('#000000')
        .text(`$${(totalEscrowCents / 100).toFixed(2)}`, 200, y)

      y += 15

      doc
        .fillColor('#666666')
        .text('Active Daily Burn:', 60, y)
        .fillColor('#000000')
        .text(`$${(combinedDailyCents / 100).toFixed(2)}/day`, 200, y)

      y += 15

      doc
        .fillColor('#666666')
        .text('Min Balance (1-day reserve):', 60, y)
        .fillColor('#ef4444')
        .text(`$${(combinedDailyCents / 100).toFixed(2)}`, 200, y)
    } catch {
      // Summary section is best-effort
    }

    // Generate PDF file
    const filename = `invoice-${invoice.invoiceNumber}.pdf`
    const filepath = join(process.cwd(), 'invoices', filename)

    // Ensure directory exists
    try {
      mkdirSync(join(process.cwd(), 'invoices'), { recursive: true })
    } catch (e) {
      // Directory might already exist
    }

    doc.pipe(createWriteStream(filepath))
    doc.end()

    // Update invoice with PDF URL
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { pdfUrl: `/invoices/${filename}` },
    })

    return filepath
  }

  /**
   * Mark invoice as paid
   */
  async markAsPaid(invoiceId: string, paymentId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) {
      throw new Error('Invoice not found')
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    })

    if (!payment || payment.status !== 'SUCCEEDED') {
      throw new Error('Invalid payment')
    }

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        amountPaid: invoice.amountPaid + payment.amount,
        paidAt: new Date(),
      },
    })
  }
}
