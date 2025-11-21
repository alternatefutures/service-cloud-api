#!/usr/bin/env tsx
/**
 * Clean up DNS records in Openprovider (removes all except NS and SOA)
 * Usage: tsx scripts/cleanup-openprovider-dns.ts <domain>
 *
 * Set CONFIRM=yes to actually delete records
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'

async function main() {
  const domain = process.argv[2] || 'alternatefutures.ai'

  const config = {
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  }

  if (!config.username || !config.password) {
    throw new Error(
      'Missing Openprovider credentials: OPENPROVIDER_USERNAME, OPENPROVIDER_PASSWORD'
    )
  }

  console.log(`\n=== Cleaning up DNS Records for ${domain} ===\n`)

  const client = new OpenProviderClient(config)

  try {
    // List all DNS records
    const records = await client.listDNSRecords(domain)

    // Filter out system records (NS and SOA)
    const recordsToDelete = records.filter(
      record => record.type !== 'NS' && record.type !== 'SOA'
    )

    if (recordsToDelete.length === 0) {
      console.log('No user-created DNS records to delete.')
      return
    }

    console.log(`Found ${recordsToDelete.length} records to delete:\n`)

    recordsToDelete.forEach(record => {
      const name = record.name || '@'
      console.log(`  - ${name} (${record.type}) → ${record.value}`)
    })

    if (process.env.CONFIRM !== 'yes') {
      console.log(
        '\n⚠️  Dry run mode. Set CONFIRM=yes to actually delete these records.'
      )
      console.log(
        'Example: CONFIRM=yes tsx scripts/cleanup-openprovider-dns.ts alternatefutures.ai'
      )
      return
    }

    console.log('\n🗑️  Deleting records...\n')

    let successCount = 0
    let failureCount = 0

    for (const record of recordsToDelete) {
      if (!record.id) {
        console.log(`⚠️  Skipping record without ID: ${record.name}`)
        failureCount++
        continue
      }

      try {
        const result = await client.deleteDNSRecord(domain, record.id)
        if (result.success) {
          successCount++
          console.log(`✓ Deleted: ${record.name || '@'} (${record.type})`)
        } else {
          failureCount++
          console.error(
            `✗ Failed to delete: ${record.name || '@'} - ${result.error}`
          )
        }
      } catch (error) {
        failureCount++
        console.error(`✗ Failed to delete: ${record.name || '@'} - ${error}`)
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log(
      `\n✅ Cleanup complete: ${successCount} deleted, ${failureCount} failed\n`
    )
  } catch (error) {
    console.error('Error during cleanup:', error)
    throw error
  }
}

main()
