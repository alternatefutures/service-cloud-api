import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InvoiceService } from './invoiceService.js'
import type { PrismaClient } from '@prisma/client'

// Mock PDFKit
const { mockPDFDocument } = vi.hoisted(() => {
  const mockPDFDocument = {
    pipe: vi.fn().mockReturnThis(),
    fontSize: vi.fn().mockReturnThis(),
    font: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    moveDown: vi.fn().mockReturnThis(),
    registerFont: vi.fn().mockReturnThis(),
    save: vi.fn().mockReturnThis(),
    restore: vi.fn().mockReturnThis(),
    translate: vi.fn().mockReturnThis(),
    scale: vi.fn().mockReturnThis(),
    path: vi.fn().mockReturnThis(),
    fill: vi.fn().mockReturnThis(),
    stroke: vi.fn().mockReturnThis(),
    fillColor: vi.fn().mockReturnThis(),
    strokeColor: vi.fn().mockReturnThis(),
    lineWidth: vi.fn().mockReturnThis(),
    lineCap: vi.fn().mockReturnThis(),
    lineJoin: vi.fn().mockReturnThis(),
    fillAndStroke: vi.fn().mockReturnThis(),
    moveTo: vi.fn().mockReturnThis(),
    lineTo: vi.fn().mockReturnThis(),
    bezierCurveTo: vi.fn().mockReturnThis(),
    quadraticCurveTo: vi.fn().mockReturnThis(),
    rect: vi.fn().mockReturnThis(),
    circle: vi.fn().mockReturnThis(),
    ellipse: vi.fn().mockReturnThis(),
    polygon: vi.fn().mockReturnThis(),
    closePath: vi.fn().mockReturnThis(),
    fillOpacity: vi.fn().mockReturnThis(),
    strokeOpacity: vi.fn().mockReturnThis(),
    miterLimit: vi.fn().mockReturnThis(),
    dash: vi.fn().mockReturnThis(),
    undash: vi.fn().mockReturnThis(),
    clip: vi.fn().mockReturnThis(),
    transform: vi.fn().mockReturnThis(),
    rotate: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn((event: string, callback: Function) => {
      if (event === 'finish') {
        setTimeout(callback, 0)
      }
      return mockPDFDocument
    }),
  }

  return { mockPDFDocument }
})

vi.mock('pdfkit', () => ({
  default: class {
    constructor() {
      return mockPDFDocument
    }
  },
}))

vi.mock('fs', () => ({
  default: {
    createWriteStream: vi.fn(() => ({
      on: vi.fn(),
    })),
    readFileSync: vi.fn(() => '<svg>Mock Logo</svg>'),
  },
  createWriteStream: vi.fn(() => ({
    on: vi.fn(),
  })),
  readFileSync: vi.fn(() => '<svg>Mock Logo</svg>'),
}))

describe('InvoiceService', () => {
  let service: InvoiceService
  let mockPrisma: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock Prisma client
    mockPrisma = {
      subscription: {
        findUnique: vi.fn(),
      },
      customer: {
        findUnique: vi.fn(),
      },
      usageRecord: {
        findMany: vi.fn(),
        groupBy: vi.fn(),
      },
      billingSettings: {
        findFirst: vi.fn(),
      },
      invoice: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      invoiceLineItem: {
        create: vi.fn(),
        createMany: vi.fn(),
      },
      payment: {
        findUnique: vi.fn(),
      },
    } as any

    service = new InvoiceService(mockPrisma as PrismaClient)
  })

  describe('generateInvoice', () => {
    it('should generate invoice for subscription', async () => {
      const subscription = {
        id: 'sub-123',
        customerId: 'cust-123',
        plan: 'PRO',
        seats: 2,
        basePricePerSeat: 2000, // $20 per seat
        usageMarkup: 0.1, // 10% markup
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      }

      const customer = {
        id: 'cust-123',
        userId: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
      }

      const billingSettings = {
        storagePerGBCents: 10,
        bandwidthPerGBCents: 5,
        computePerHourCents: 20,
        requestsPer1000Cents: 1,
      }

      const usageRecords = [
        { type: 'STORAGE', quantity: 100, unit: 'GB' },
        { type: 'BANDWIDTH', quantity: 200, unit: 'GB' },
      ]

      const createdInvoice = {
        id: 'inv-123',
        customerId: 'cust-123',
        subscriptionId: 'sub-123',
        invoiceNumber: 'INV-001',
        status: 'OPEN',
        subtotal: 5550, // (2 * 2000) + ((100*10 + 200*5) * 1.1)
        total: 5550,
        amountDue: 5550,
      }

      mockPrisma.subscription.findUnique.mockResolvedValue(subscription)
      mockPrisma.customer.findUnique.mockResolvedValue(customer)
      mockPrisma.billingSettings.findFirst.mockResolvedValue(billingSettings)
      mockPrisma.usageRecord.findMany.mockResolvedValue(usageRecords)
      mockPrisma.usageRecord.groupBy.mockResolvedValue([
        { type: 'STORAGE', _sum: { amount: 1000 } },
        { type: 'BANDWIDTH', _sum: { amount: 1000 } },
      ])
      mockPrisma.invoice.create.mockResolvedValue(createdInvoice)
      mockPrisma.invoiceLineItem.createMany.mockResolvedValue({ count: 3 })

      const result = await service.generateInvoice('sub-123')

      expect(result).toBe('inv-123')
      expect(mockPrisma.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          subscriptionId: 'sub-123',
          status: 'OPEN',
        }),
      })
      expect(mockPrisma.invoiceLineItem.create).toHaveBeenCalled()
    })

    it('should throw error if subscription not found', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null)

      await expect(service.generateInvoice('sub-123')).rejects.toThrow(
        'Subscription not found'
      )
    })

    it('should apply usage markup correctly', async () => {
      const subscription = {
        id: 'sub-123',
        customerId: 'cust-123',
        plan: 'ENTERPRISE',
        seats: 5,
        basePricePerSeat: 5000, // $50 per seat
        usageMarkup: 0.25, // 25% markup
        currentPeriodStart: new Date('2025-01-01'),
        currentPeriodEnd: new Date('2025-01-31'),
      }

      const customer = {
        id: 'cust-123',
        userId: 'user-123',
      }

      const billingSettings = {
        storagePerGBCents: 10,
        bandwidthPerGBCents: 5,
        computePerHourCents: 20,
        requestsPer1000Cents: 1,
      }

      const usageRecords = [
        { type: 'STORAGE', quantity: 1000, unit: 'GB' }, // 1000 * 10 = 10000 cents
      ]

      mockPrisma.subscription.findUnique.mockResolvedValue(subscription)
      mockPrisma.customer.findUnique.mockResolvedValue(customer)
      mockPrisma.billingSettings.findFirst.mockResolvedValue(billingSettings)
      mockPrisma.usageRecord.findMany.mockResolvedValue(usageRecords)
      mockPrisma.usageRecord.groupBy.mockResolvedValue([
        { type: 'STORAGE', _sum: { amount: 10000 } },
      ])
      mockPrisma.invoice.create.mockImplementation(args => {
        // Verify that usage markup was applied
        // Base: 5 * 5000 = 25000
        // Usage: 10000 * 1.25 = 12500
        // Total: 37500
        expect(args.data.subtotal).toBe(37500)
        return Promise.resolve({
          id: 'inv-456',
          ...args.data,
        })
      })
      mockPrisma.invoiceLineItem.createMany.mockResolvedValue({ count: 2 })

      await service.generateInvoice('sub-123')
    })
  })

  describe('generatePDF', () => {
    it('should generate PDF for invoice', async () => {
      const invoice = {
        id: 'inv-123',
        invoiceNumber: 'INV-001',
        customer: {
          name: 'Test User',
          email: 'test@example.com',
        },
        subscription: {
          plan: 'PRO',
        },
        lineItems: [
          {
            description: 'PRO Plan - 2 seats',
            quantity: 2,
            unitPrice: 2000,
            amount: 4000,
          },
          {
            description: 'Usage charges',
            quantity: 1,
            unitPrice: 1500,
            amount: 1500,
          },
        ],
        subtotal: 5500,
        taxAmount: 0,
        total: 5500,
        amountDue: 5500,
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        dueDate: new Date('2025-02-15'),
        createdAt: new Date('2025-01-31'),
      }

      mockPrisma.invoice.findUnique.mockResolvedValue(invoice)
      mockPrisma.invoice.update.mockResolvedValue({
        ...invoice,
        pdfUrl: '/invoices/inv-123.pdf',
      })

      const result = await service.generatePDF('inv-123')

      expect(result).toContain('invoices')
      expect(result).toContain('INV-001')
      expect(result).toContain('.pdf')
      expect(mockPDFDocument.text).toHaveBeenCalled()
      expect(mockPDFDocument.end).toHaveBeenCalled()
    })

    it('should throw error if invoice not found', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(null)

      await expect(service.generatePDF('inv-123')).rejects.toThrow(
        'Invoice not found'
      )
    })
  })

  describe('markAsPaid', () => {
    it('should mark invoice as paid', async () => {
      const invoice = {
        id: 'inv-123',
        status: 'OPEN',
        amountDue: 5000,
        amountPaid: 0,
      }

      const payment = {
        id: 'payment-123',
        amount: 5000,
        status: 'SUCCEEDED',
      }

      mockPrisma.invoice.findUnique.mockResolvedValue(invoice)
      mockPrisma.payment.findUnique.mockResolvedValue(payment)
      mockPrisma.invoice.update.mockResolvedValue({
        ...invoice,
        status: 'PAID',
        paidAt: new Date(),
        amountPaid: 5000,
      })

      await service.markAsPaid('inv-123', 'payment-123')

      expect(mockPrisma.invoice.update).toHaveBeenCalledWith({
        where: { id: 'inv-123' },
        data: {
          status: 'PAID',
          paidAt: expect.any(Date),
          amountPaid: 5000,
        },
      })
    })

    it('should throw error if invoice not found', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(null)

      await expect(
        service.markAsPaid('inv-123', 'payment-123')
      ).rejects.toThrow('Invoice not found')
    })
  })
})
