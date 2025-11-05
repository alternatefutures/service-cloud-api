/**
 * Invoice Generation Service
 *
 * Generates and manages invoices
 */

import type { PrismaClient } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { writeFileSync } from 'fs';
import { join } from 'path';

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
      },
    });

    if (!subscription) {
      throw new Error('Subscription not found');
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
    });

    // Calculate amounts
    const baseAmount = Number(subscription.basePricePerSeat) * subscription.seats;
    let usageAmount = 0;

    for (const item of usage) {
      usageAmount += item._sum.amount || 0;
    }

    // Apply usage markup
    const usageMarkup = Number(subscription.usageMarkup);
    const markedUpUsage = Math.ceil(usageAmount * (1 + usageMarkup));

    const subtotal = baseAmount + markedUpUsage;

    // Get tax rate
    const settings = await this.prisma.billingSettings.findFirst();
    const taxRate = Number(settings?.taxRatePercent || 0);
    const tax = Math.ceil(subtotal * taxRate);

    const total = subtotal + tax;

    // Generate invoice number
    const invoiceNumber = `INV-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Calculate due date
    const dueDate = new Date(subscription.currentPeriodEnd);
    dueDate.setDate(dueDate.getDate() + (settings?.invoiceDueDays || 30));

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
    });

    // Create line items
    // Base subscription
    await this.prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        description: `${subscription.plan} Plan - ${subscription.seats} seat(s)`,
        quantity: subscription.seats,
        unitPrice: Number(subscription.basePricePerSeat),
        amount: baseAmount,
      },
    });

    // Usage line items
    for (const item of usage) {
      const quantity = Number(item._sum.quantity || 0);
      const amount = item._sum.amount || 0;
      const markedUp = Math.ceil(amount * (1 + usageMarkup));

      await this.prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          description: `${item.type} Usage`,
          quantity,
          unitPrice: amount > 0 ? Math.ceil((amount / quantity) * 100) / 100 : 0,
          amount: markedUp,
          metadata: { type: item.type },
        },
      });
    }

    return invoice.id;
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
    });

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50 });

    // Header
    doc
      .fontSize(20)
      .text('INVOICE', 50, 50)
      .fontSize(10)
      .text(`Invoice #: ${invoice.invoiceNumber}`, 50, 80)
      .text(`Date: ${invoice.createdAt.toLocaleDateString()}`, 50, 95)
      .text(`Due Date: ${invoice.dueDate?.toLocaleDateString() || 'N/A'}`, 50, 110);

    // Customer info
    doc
      .fontSize(12)
      .text('Bill To:', 50, 140)
      .fontSize(10)
      .text(invoice.customer.name || 'N/A', 50, 155)
      .text(invoice.customer.email || 'N/A', 50, 170);

    // Line items table
    let y = 220;
    doc
      .fontSize(10)
      .text('Description', 50, y)
      .text('Quantity', 280, y)
      .text('Unit Price', 350, y)
      .text('Amount', 450, y);

    doc.moveTo(50, y + 15).lineTo(550, y + 15).stroke();

    y += 25;
    for (const item of invoice.lineItems) {
      doc
        .text(item.description, 50, y)
        .text(item.quantity.toString(), 280, y)
        .text(`$${(item.unitPrice / 100).toFixed(2)}`, 350, y)
        .text(`$${(item.amount / 100).toFixed(2)}`, 450, y);
      y += 20;
    }

    // Totals
    y += 20;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 15;

    doc
      .text('Subtotal:', 350, y)
      .text(`$${(invoice.subtotal / 100).toFixed(2)}`, 450, y);
    y += 20;

    doc
      .text('Tax:', 350, y)
      .text(`$${(invoice.tax / 100).toFixed(2)}`, 450, y);
    y += 20;

    doc
      .fontSize(12)
      .text('Total:', 350, y)
      .text(`$${(invoice.total / 100).toFixed(2)}`, 450, y);

    // Generate PDF file
    const filename = `invoice-${invoice.invoiceNumber}.pdf`;
    const filepath = join(process.cwd(), 'invoices', filename);

    // Ensure directory exists
    try {
      const fs = await import('fs');
      fs.mkdirSync(join(process.cwd(), 'invoices'), { recursive: true });
    } catch (e) {
      // Directory might already exist
    }

    doc.pipe(require('fs').createWriteStream(filepath));
    doc.end();

    // Update invoice with PDF URL
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { pdfUrl: `/invoices/${filename}` },
    });

    return filepath;
  }

  /**
   * Mark invoice as paid
   */
  async markAsPaid(invoiceId: string, paymentId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment || payment.status !== 'SUCCEEDED') {
      throw new Error('Invalid payment');
    }

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        amountPaid: invoice.amountPaid + payment.amount,
        paidAt: new Date(),
      },
    });
  }
}
