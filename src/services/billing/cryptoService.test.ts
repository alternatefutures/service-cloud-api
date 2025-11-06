import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CryptoService } from './cryptoService.js';
import type { PrismaClient } from '@prisma/client';

// Mock ethers
const { mockEthProvider, MockJsonRpcProvider } = vi.hoisted(() => {
  const mockEthProvider = {
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
  };

  class MockJsonRpcProvider {
    getTransactionReceipt = mockEthProvider.getTransactionReceipt;
    getTransaction = mockEthProvider.getTransaction;
    constructor(url: string) {}
  }

  return { mockEthProvider, MockJsonRpcProvider };
});

// Mock Solana
const { mockSolConnection, MockConnection } = vi.hoisted(() => {
  const mockSolConnection = {
    getTransaction: vi.fn(),
  };

  class MockConnection {
    getTransaction = mockSolConnection.getTransaction;
    constructor(endpoint: string) {}
  }

  return { mockSolConnection, MockConnection };
});

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: MockJsonRpcProvider,
    formatEther: vi.fn((value: bigint) => (Number(value) / 1e18).toString()),
    getAddress: vi.fn((address: string) => address), // Mock address validation
  },
}));

vi.mock('@solana/web3.js', () => ({
  Connection: MockConnection,
  LAMPORTS_PER_SOL: 1000000000,
  PublicKey: class MockPublicKey {
    constructor(public address: string) {}
    toBase58() {
      return this.address;
    }
  },
}));

describe('CryptoService', () => {
  let service: CryptoService;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up environment variables
    process.env.ETH_RPC_URL = 'https://eth.example.com';
    process.env.SOLANA_RPC_URL = 'https://sol.example.com';
    process.env.ETH_PAYMENT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
    process.env.SOLANA_PAYMENT_ADDRESS = 'SolanaAddress123456789';
    process.env.ARWEAVE_PAYMENT_ADDRESS = 'ArweaveAddress123456789';
    process.env.FILECOIN_PAYMENT_ADDRESS = 'FilecoinAddress123456789';

    // Create mock Prisma client
    mockPrisma = {
      customer: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      paymentMethod: {
        create: vi.fn(),
        updateMany: vi.fn(),
        findFirst: vi.fn(),
      },
      payment: {
        create: vi.fn(),
        update: vi.fn(),
      },
      invoice: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    service = new CryptoService(mockPrisma as PrismaClient);
  });

  describe('addCryptoWallet', () => {
    it('should add Ethereum wallet', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const createdPaymentMethod = {
        id: 'pm-123',
        type: 'CRYPTO_WALLET',
        blockchain: 'ethereum',
        walletAddress: '0xabcd',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.paymentMethod.create.mockResolvedValue(createdPaymentMethod);
      mockPrisma.paymentMethod.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.addCryptoWallet('user-123', '0xabcd', 'ethereum');

      expect(result).toBe('pm-123');
      expect(mockPrisma.paymentMethod.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          type: 'CRYPTO_WALLET',
          blockchain: 'ethereum',
          walletAddress: '0xabcd',
        }),
      });
    });

    it('should add Solana wallet', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const createdPaymentMethod = {
        id: 'pm-456',
        type: 'CRYPTO_WALLET',
        blockchain: 'solana',
        walletAddress: 'SolAddr123',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.paymentMethod.create.mockResolvedValue(createdPaymentMethod);
      mockPrisma.paymentMethod.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.addCryptoWallet('user-123', 'SolAddr123', 'solana');

      expect(result).toBe('pm-456');
      expect(mockPrisma.paymentMethod.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'cust-123',
          type: 'CRYPTO_WALLET',
          blockchain: 'solana',
          walletAddress: 'SolAddr123',
        }),
      });
    });

    it('should throw error if customer not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(
        service.addCryptoWallet('user-123', '0xabcd', 'ethereum')
      ).rejects.toThrow('Customer not found');
    });
  });

  describe('verifyEthereumTransaction', () => {
    it('should verify valid Ethereum transaction', async () => {
      const txReceipt = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        status: 1,
        logs: [
          {
            topics: [],
            data: '0x',
          },
        ],
      };

      const txDetails = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        value: BigInt('1000000000000000000'), // 1 ETH in wei
      };

      mockEthProvider.getTransactionReceipt.mockResolvedValue(txReceipt);
      mockEthProvider.getTransaction.mockResolvedValue(txDetails);

      // Pass amount in wei (1 ETH = 1e18 wei)
      const result = await service.verifyTransaction(
        '0xtxhash',
        'ethereum',
        1000000000000000000, // 1 ETH in wei
        '0x1234567890abcdef1234567890abcdef12345678'
      );

      expect(result).toBe(true);
    });

    it('should reject transaction with wrong recipient', async () => {
      const txReceipt = {
        to: '0xwrongaddress',
        status: 1,
        logs: [],
      };

      const txDetails = {
        to: '0xwrongaddress',
        value: BigInt('1000000000000000000'),
      };

      mockEthProvider.getTransactionReceipt.mockResolvedValue(txReceipt);
      mockEthProvider.getTransaction.mockResolvedValue(txDetails);

      const result = await service.verifyTransaction(
        '0xtxhash',
        'ethereum',
        1,
        '0x1234567890abcdef1234567890abcdef12345678'
      );

      expect(result).toBe(false);
    });

    it('should reject failed transaction', async () => {
      const txReceipt = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        status: 0, // Failed
        logs: [],
      };

      mockEthProvider.getTransactionReceipt.mockResolvedValue(txReceipt);
      mockEthProvider.getTransaction.mockResolvedValue(null);

      const result = await service.verifyTransaction(
        '0xtxhash',
        'ethereum',
        1,
        '0x1234567890abcdef1234567890abcdef12345678'
      );

      expect(result).toBe(false);
    });
  });

  describe('verifySolanaTransaction', () => {
    it('should verify valid Solana transaction', async () => {
      const transaction = {
        meta: {
          err: null,
          postBalances: [2000000000, 1000000000],
          preBalances: [1000000000, 2000000000],
        },
        transaction: {
          message: {
            staticAccountKeys: [
              { equals: (key: any) => key.address === 'sender' },
              { equals: (key: any) => key.address === 'SolanaAddress123456789' },
            ],
          },
        },
      };

      mockSolConnection.getTransaction.mockResolvedValue(transaction);

      const result = await service.verifyTransaction(
        'soltxhash',
        'solana',
        1,
        'SolanaAddress123456789'
      );

      expect(result).toBe(true);
    });

    it('should reject transaction with insufficient amount', async () => {
      const transaction = {
        meta: {
          err: null,
          postBalances: [1500000000, 500000000],
          preBalances: [1000000000, 1000000000],
        },
        transaction: {
          message: {
            accountKeys: [
              { toBase58: () => 'sender' },
              { toBase58: () => 'SolanaAddress123456789' },
            ],
          },
        },
      };

      mockSolConnection.getTransaction.mockResolvedValue(transaction);

      const result = await service.verifyTransaction(
        'soltxhash',
        'solana',
        1,
        'SolanaAddress123456789'
      );

      expect(result).toBe(false);
    });
  });

  describe('recordCryptoPayment', () => {
    it('should record crypto payment successfully', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const paymentMethod = { id: 'pm-123', blockchain: 'ethereum' };
      const createdPayment = {
        id: 'payment-123',
        customerId: 'cust-123',
        amount: 100,
        currency: 'ETHEREUM',
        status: 'PROCESSING',
      };
      const updatedPayment = {
        ...createdPayment,
        status: 'COMPLETED',
      };

      // Mock successful transaction verification
      const txReceipt = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        status: 1,
        logs: [],
      };

      const txDetails = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        value: BigInt('1000000000000000000'),
      };

      mockEthProvider.getTransactionReceipt.mockResolvedValue(txReceipt);
      mockEthProvider.getTransaction.mockResolvedValue(txDetails);

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(paymentMethod);
      mockPrisma.payment.create.mockResolvedValue(createdPayment);
      mockPrisma.payment.update.mockResolvedValue(updatedPayment);

      const result = await service.recordCryptoPayment(
        'user-123',
        '0xtxhash',
        'ethereum',
        100
      );

      expect(result).toBe('payment-123');
      expect(mockPrisma.payment.create).toHaveBeenCalled();
    });

    it('should link payment to invoice if provided', async () => {
      const customer = { id: 'cust-123', userId: 'user-123' };
      const paymentMethod = { id: 'pm-123', blockchain: 'ethereum' };
      const invoice = { id: 'inv-123', amountDue: 10000 };
      const createdPayment = {
        id: 'payment-123',
        invoiceId: 'inv-123',
        status: 'PROCESSING',
      };
      const updatedPayment = {
        ...createdPayment,
        status: 'COMPLETED',
      };

      // Mock successful transaction
      const txReceipt = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        status: 1,
        logs: [],
      };

      const txDetails = {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        value: BigInt('1000000000000000000'),
      };

      mockEthProvider.getTransactionReceipt.mockResolvedValue(txReceipt);
      mockEthProvider.getTransaction.mockResolvedValue(txDetails);

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(paymentMethod);
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      mockPrisma.payment.create.mockResolvedValue(createdPayment);
      mockPrisma.payment.update.mockResolvedValue(updatedPayment);
      mockPrisma.invoice.update.mockResolvedValue({ ...invoice, status: 'PAID' });

      const result = await service.recordCryptoPayment(
        'user-123',
        '0xtxhash',
        'ethereum',
        100,
        'inv-123'
      );

      expect(result).toBe('payment-123');
      expect(mockPrisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: 'inv-123',
        }),
      });
    });
  });
});
