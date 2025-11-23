/**
 * Derive Filecoin private key from BIP39 seed phrase
 * Usage: node scripts/derive-filecoin-key.js "your seed phrase here"
 */

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

// Filecoin uses BIP44 derivation path: m/44'/461'/0'/0/0
// 461 is Filecoin's coin type
const FILECOIN_PATH = "m/44'/461'/0'/0/0"

function deriveFilecoinKey(mnemonic) {
  // Validate mnemonic
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase')
  }

  // Convert mnemonic to seed
  const seed = mnemonicToSeedSync(mnemonic)

  // Create HD key from seed
  const hdkey = HDKey.fromMasterSeed(seed)

  // Derive key using Filecoin's path
  const derived = hdkey.derive(FILECOIN_PATH)

  if (!derived.privateKey) {
    throw new Error('Failed to derive private key')
  }

  // Return as hex string
  return Buffer.from(derived.privateKey).toString('hex')
}

// Get mnemonic from command line argument
const mnemonic = process.argv[2]

if (!mnemonic) {
  console.error(
    'Usage: node scripts/derive-filecoin-key.js "your seed phrase here"'
  )
  console.error('\nExample:')
  console.error('  node scripts/derive-filecoin-key.js "word1 word2 word3..."')
  process.exit(1)
}

try {
  const privateKey = deriveFilecoinKey(mnemonic)
  console.log('\n✅ Filecoin Private Key (hex):')
  console.log(privateKey)
  console.log('\n⚠️  Keep this private key secure!')
  console.log('Use this value for FILECOIN_WALLET_KEY environment variable\n')
} catch (error) {
  console.error('❌ Error:', error.message)
  process.exit(1)
}
