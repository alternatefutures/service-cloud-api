/**
 * Akash JS SDK initialization.
 *
 * Uses @akashnetwork/chain-sdk + @cosmjs for wallet and chain interactions.
 * Provider auth: JWT (automatic in provider-services v0.10.0+).
 *
 * The deployment pipeline uses CLI commands (akash + provider-services) which
 * handle JWT auth automatically. This module provides wallet/chain SDK access
 * for programmatic queries and future direct-SDK deployments.
 */

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
// @ts-ignore — sub-path exports resolve at runtime via Node ESM
import { createChainNodeSDK } from '@akashnetwork/chain-sdk/chain'
// @ts-ignore
import { SDL } from '@akashnetwork/chain-sdk/sdl'

export type ChainNodeSDK = ReturnType<typeof createChainNodeSDK>
export { SDL }

export interface AkashSDKContext {
  wallet: DirectSecp256k1HdWallet
  chainSDK: ChainNodeSDK
  ownerAddress: string
}

let sdkContext: AkashSDKContext | null = null

/**
 * Initialize the Akash SDK context: wallet, signing client, chain SDK.
 * Cached as a singleton — subsequent calls return the same context.
 */
export async function getAkashSDKContext(): Promise<AkashSDKContext> {
  if (sdkContext) return sdkContext

  const mnemonic = (process.env.AKASH_MNEMONIC || '').trim()
  if (!mnemonic) {
    throw new Error('AKASH_MNEMONIC is not set')
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'akash',
  })

  const accounts = await wallet.getAccounts()
  if (!accounts.length) throw new Error('No accounts found in wallet')
  const ownerAddress = accounts[0].address

  const rpcEndpoint = process.env.RPC_ENDPOINT || 'https://akash-rpc.polkachu.com:443'
  const grpcEndpoint = process.env.GRPC_ENDPOINT || 'https://akash-grpc.publicnode.com:443'

  const chainSDK = createChainNodeSDK({
    query: { baseUrl: grpcEndpoint },
    tx: {
      baseUrl: rpcEndpoint,
      signer: wallet,
      defaultFeeAmount: '25000',
    },
  })

  sdkContext = { wallet, chainSDK, ownerAddress }
  console.log(`[AkashSDK] Initialized for ${ownerAddress}`)
  return sdkContext
}
