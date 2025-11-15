/**
 * Update DNS for Akash Deployment
 * Automatically syncs DNS records after Akash deployment
 *
 * Usage:
 *   tsx scripts/update-akash-dns.ts <dseq> <provider> [--testnet]
 *
 * Example:
 *   tsx scripts/update-akash-dns.ts 12345 akash1abc... --testnet
 */

import { AkashDNSSync } from '../src/services/dns/index.js'
import dotenv from 'dotenv'

dotenv.config()

async function main() {
  const args = process.argv.slice(2)
  const dseq = args[0]
  const provider = args[1]
  const isTestnet = args.includes('--testnet')

  if (!dseq || !provider) {
    console.error(
      'Usage: tsx scripts/update-akash-dns.ts <dseq> <provider> [--testnet]'
    )
    process.exit(1)
  }

  // OpenProvider credentials from environment
  const openProviderConfig = {
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  }

  if (!openProviderConfig.username || !openProviderConfig.password) {
    console.error(
      'Missing OPENPROVIDER_USERNAME or OPENPROVIDER_PASSWORD in .env'
    )
    process.exit(1)
  }

  // Initialize DNS sync
  const akashNode = isTestnet
    ? 'https://rpc.sandbox-01.aksh.pw:443'
    : 'https://rpc.akashnet.net:443'

  const akashChainId = isTestnet ? 'sandbox-01' : 'akashnet-2'

  const dnsSync = new AkashDNSSync(
    openProviderConfig,
    'alternatefutures.ai',
    akashNode,
    akashChainId
  )

  console.log(`\n< Updating DNS for Akash deployment...`)
  console.log(`  DSEQ: ${dseq}`)
  console.log(`  Provider: ${provider}`)
  console.log(`  Network: ${isTestnet ? 'Testnet' : 'Mainnet'}\n`)

  // Sync DNS
  const results = isTestnet
    ? await dnsSync.syncTestnetDNS(dseq, provider)
    : await dnsSync.syncMainnetDNS(dseq, provider)

  // Display results
  console.log(`\n=� DNS Update Results:`)
  for (const result of results) {
    if (result.success) {
      console.log(`   Updated: ${result.recordId}`)
    } else {
      console.log(`  L Failed: ${result.error}`)
    }
  }

  // Verify DNS propagation
  console.log(`\n=
 Verifying DNS propagation...`)
  const verified = await dnsSync.verifyDeploymentDNS(dseq, provider, isTestnet)

  if (verified) {
    console.log(` All DNS records verified successfully!`)
  } else {
    console.log(`�  Some DNS records failed verification`)
  }

  // Export deployment config
  const deployment = await dnsSync.exportDeploymentConfig(dseq, provider)
  if (deployment) {
    console.log(`\n=� Deployment Configuration:`)
    for (const service of deployment.services) {
      console.log(`  ${service.name}:`)
      console.log(`    Subdomain: ${service.subdomain}`)
      console.log(`    IP: ${service.externalIP}`)
      console.log(`    Port: ${service.port}`)
    }
  }
}

main().catch(error => {
  console.error('Error:', error)
  process.exit(1)
})
