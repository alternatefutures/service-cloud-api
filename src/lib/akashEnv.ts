/**
 * Shared Akash CLI environment variables.
 *
 * SINGLE SOURCE OF TRUTH — every module that shells out to `akash` or
 * `provider-services` MUST use this function.  Duplicating the env map
 * is how the EscrowHealthMonitor shipped without AKASH_FROM and silently
 * failed every refill for weeks.
 */

export interface AkashEnvOptions {
  /** Override broadcast mode (default: 'sync'). providerVerification uses 'block'. */
  broadcastMode?: 'sync' | 'block'
  /** Skip the AKASH_MNEMONIC check (for read-only query commands). */
  skipMnemonicCheck?: boolean
}

export function getAkashEnv(opts: AkashEnvOptions = {}): Record<string, string> {
  if (!opts.skipMnemonicCheck && !process.env.AKASH_MNEMONIC) {
    throw new Error('AKASH_MNEMONIC is not set')
  }

  const keyName = process.env.AKASH_KEY_NAME || 'default'

  return {
    ...(process.env as Record<string, string>),
    AKASH_KEY_NAME: keyName,
    AKASH_FROM: keyName,
    AKASH_KEYRING_BACKEND: 'test',
    AKASH_NODE: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
    AKASH_CHAIN_ID: process.env.AKASH_CHAIN_ID || 'akashnet-2',
    AKASH_GAS: 'auto',
    AKASH_GAS_ADJUSTMENT: '1.5',
    AKASH_GAS_PRICES: '0.025uakt',
    AKASH_BROADCAST_MODE: opts.broadcastMode || 'sync',
    AKASH_YES: 'true',
    HOME: process.env.HOME || '/home/nodejs',
  }
}
