/**
 * Crypto Payment Service
 *
 * Handles cryptocurrency payment processing for multiple blockchains
 */

import { ethers } from 'ethers'
import { Connection, PublicKey } from '@solana/web3.js'
import type { PrismaClient } from '@prisma/client'

export class CryptoService {
  private ethProvider: ethers.JsonRpcProvider
  private solConnection: Connection

  constructor(private prisma: PrismaClient) {
    // Initialize providers
    this.ethProvider = new ethers.JsonRpcProvider(
      process.env.ETH_RPC_URL || 'https://mainnet.infura.io/v3/your-project-id'
    )
    this.solConnection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    )
  }

  /**
   * Add crypto wallet as payment method
   */
  async addCryptoWallet(
    userId: string,
    walletAddress: string,
    blockchain: 'ethereum' | 'solana' | 'arweave' | 'filecoin'
  ): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    })

    if (!customer) {
      throw new Error('Customer not found')
    }

    // Verify wallet address format
    try {
      if (blockchain === 'ethereum') {
        ethers.getAddress(walletAddress) // Validates Ethereum address
      } else if (blockchain === 'solana') {
        new PublicKey(walletAddress) // Validates Solana address
      }
    } catch (error) {
      throw new Error('Invalid wallet address format')
    }

    // Create payment method record
    const paymentMethod = await this.prisma.paymentMethod.create({
      data: {
        customerId: customer.id,
        type: 'CRYPTO_WALLET',
        walletAddress,
        blockchain,
      },
    })

    return paymentMethod.id
  }

  /**
   * Verify crypto payment transaction
   */
  async verifyTransaction(
    txHash: string,
    blockchain: string,
    expectedAmount: number,
    recipientAddress: string
  ): Promise<boolean> {
    try {
      if (blockchain === 'ethereum') {
        return await this.verifyEthereumTransaction(
          txHash,
          expectedAmount,
          recipientAddress
        )
      } else if (blockchain === 'solana') {
        return await this.verifySolanaTransaction(
          txHash,
          expectedAmount,
          recipientAddress
        )
      }
      // Add support for Arweave, Filecoin as needed
      return false
    } catch (error) {
      console.error('Transaction verification failed:', error)
      return false
    }
  }

  /**
   * Verify Ethereum transaction
   */
  private async verifyEthereumTransaction(
    txHash: string,
    expectedAmount: number,
    recipientAddress: string
  ): Promise<boolean> {
    const tx = await this.ethProvider.getTransaction(txHash)
    if (!tx) return false

    const receipt = await this.ethProvider.getTransactionReceipt(txHash)
    if (!receipt || receipt.status !== 1) return false // Not successful

    // Verify recipient and amount
    const valueInEth = Number(ethers.formatEther(tx.value))
    const expectedInEth = expectedAmount / 1e18 // Convert from wei

    return (
      tx.to?.toLowerCase() === recipientAddress.toLowerCase() &&
      Math.abs(valueInEth - expectedInEth) < 0.0001 // Allow small rounding differences
    )
  }

  /**
   * Verify Solana transaction
   */
  private async verifySolanaTransaction(
    txHash: string,
    expectedAmount: number,
    recipientAddress: string
  ): Promise<boolean> {
    const tx = await this.solConnection.getTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    })

    if (!tx || !tx.meta) return false

    // Verify transaction succeeded
    if (tx.meta.err) return false

    // Check recipient and amount in transaction
    // This is simplified - in production, you'd parse the transaction more carefully
    const recipientPubkey = new PublicKey(recipientAddress)
    const accountIndex = tx.transaction.message.staticAccountKeys.findIndex(
      key => key.equals(recipientPubkey)
    )

    if (accountIndex === -1) return false

    // Verify amount (simplified - would need to check actual transfer amount)
    return true
  }

  /**
   * Record crypto payment
   */
  async recordCryptoPayment(
    userId: string,
    txHash: string,
    blockchain: string,
    amount: number,
    invoiceId?: string
  ): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    })

    if (!customer) {
      throw new Error('Customer not found')
    }

    // Find payment method for this blockchain
    const paymentMethod = await this.prisma.paymentMethod.findFirst({
      where: {
        customerId: customer.id,
        blockchain,
        type: 'CRYPTO_WALLET',
      },
    })

    // Create payment record
    const payment = await this.prisma.payment.create({
      data: {
        customerId: customer.id,
        invoiceId,
        paymentMethodId: paymentMethod?.id,
        txHash,
        blockchain,
        amount,
        currency: blockchain.toUpperCase(),
        status: 'PROCESSING',
      },
    })

    // Verify transaction in background
    // In production, you'd use a queue/worker for this
    this.verifyAndUpdatePayment(payment.id, txHash, blockchain, amount)

    return payment.id
  }

  /**
   * Verify and update payment status
   */
  private async verifyAndUpdatePayment(
    paymentId: string,
    txHash: string,
    blockchain: string,
    amount: number
  ): Promise<void> {
    try {
      const recipientAddress =
        process.env[`${blockchain.toUpperCase()}_WALLET_ADDRESS`] || ''
      const verified = await this.verifyTransaction(
        txHash,
        blockchain,
        amount,
        recipientAddress
      )

      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: verified ? 'SUCCEEDED' : 'FAILED',
          failureMessage: verified ? null : 'Transaction verification failed',
        },
      })

      // If verified and linked to invoice, mark invoice as paid
      if (verified) {
        const payment = await this.prisma.payment.findUnique({
          where: { id: paymentId },
          include: { invoice: true },
        })

        if (payment?.invoice) {
          await this.prisma.invoice.update({
            where: { id: payment.invoice.id },
            data: {
              status: 'PAID',
              amountPaid: payment.invoice.amountPaid + amount,
              paidAt: new Date(),
            },
          })
        }
      }
    } catch (error) {
      console.error('Payment verification failed:', error)
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'FAILED',
          failureMessage: 'Verification error',
        },
      })
    }
  }
}
