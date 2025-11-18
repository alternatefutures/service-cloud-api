#!/usr/bin/env tsx
/**
 * Sync DNS records after Akash deployment
 * Usage: tsx scripts/sync-dns.ts <dseq> <provider>
 */

import { AkashDNSSync } from '../src/services/dns/akashDnsSync.js'

async function main() {
  const dseq = process.argv[2]
  const provider = process.argv[3]
  const isTestnet = process.argv[4] === 'testnet'

  if (!dseq || !provider) {
    console.error('Usage: tsx scripts/sync-dns.ts <dseq> <provider> [testnet]')
    process.exit(1)
  }

  // Get config from environment
  const openProviderConfig = {
    username: process.env.OPENPROVIDER_USERNAME || '',
    password: process.env.OPENPROVIDER_PASSWORD || '',
    apiUrl: process.env.OPENPROVIDER_API_URL,
  }

  const domain = process.env.DOMAIN || 'alternatefutures.ai'
  const akashNode = process.env.AKASH_NODE || 'https://rpc.akashnet.net:443'
  const akashChainId = process.env.AKASH_CHAIN_ID || 'akashnet-2'

  if (!openProviderConfig.username || !openProviderConfig.password) {
    console.error(
      'Error: OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD must be set'
    )
    process.exit(1)
  }

  console.log('=== Akash DNS Sync ===')
  console.log(`Domain: ${domain}`)
  console.log(`DSEQ: ${dseq}`)
  console.log(`Provider: ${provider}`)
  console.log(`Network: ${isTestnet ? 'testnet' : 'mainnet'}`)
  console.log(`Akash Node: ${akashNode}`)
  console.log('')

  const sync = new AkashDNSSync(
    openProviderConfig,
    domain,
    akashNode,
    akashChainId
  )

  try {
    console.log('Fetching deployment details...')
    const deployment = await sync.getDeploymentDetails(dseq, provider)

    if (!deployment) {
      console.error('Failed to get deployment details')
      process.exit(1)
    }

    console.log(`Found ${deployment.services.length} services:`)
    deployment.services.forEach(service => {
      console.log(
        `  - ${service.name}: ${service.externalIP}:${service.port || 'N/A'}`
      )
    })
    console.log('')

    console.log('Updating DNS records...')
    const results = isTestnet
      ? await sync.syncTestnetDNS(dseq, provider)
      : await sync.syncMainnetDNS(dseq, provider)

    console.log('')
    console.log('=== DNS Update Results ===')
    let successCount = 0
    let failureCount = 0

    results.forEach((result, index) => {
      if (result.success) {
        successCount++
        console.log(
          `✓ ${deployment.services[index]?.subdomain || `Service ${index}`}: Success (Record ID: ${result.recordId})`
        )
        if (result.propagationTime) {
          console.log(`  Propagation time: ${result.propagationTime}ms`)
        }
      } else {
        failureCount++
        console.log(
          `✗ ${deployment.services[index]?.subdomain || `Service ${index}`}: Failed`
        )
        if (result.error) {
          console.log(`  Error: ${result.error}`)
        }
      }
    })

    console.log('')
    console.log(`Total: ${successCount} succeeded, ${failureCount} failed`)

    if (failureCount > 0) {
      process.exit(1)
    }

    console.log('')
    console.log('Verifying DNS propagation...')
    const verified = await sync.verifyDeploymentDNS(dseq, provider, isTestnet)

    if (verified) {
      console.log('✓ All DNS records verified!')
    } else {
      console.error('✗ DNS verification failed')
      console.log('Note: DNS records may take a few minutes to propagate')
      // Don't exit with error for verification failures, just warn
    }

    console.log('')
    console.log('=== DNS Sync Complete ===')
  } catch (error) {
    console.error('Error syncing DNS:', error)
    process.exit(1)
  }
}

main()
