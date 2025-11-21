#!/usr/bin/env tsx
/**
 * List all DNS records in Openprovider for a domain
 * Usage: tsx scripts/list-openprovider-dns.ts <domain>
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

  console.log(`\n=== DNS Records for ${domain} in Openprovider ===\n`)

  const client = new OpenProviderClient(config)

  try {
    // List all DNS records
    const records = await client.listDNSRecords(domain)

    if (records.length === 0) {
      console.log('No DNS records found.')
      return
    }

    console.log(`Found ${records.length} DNS records:\n`)

    // Group records by type
    const recordsByType: Record<string, typeof records> = {}
    records.forEach(record => {
      if (!recordsByType[record.type]) {
        recordsByType[record.type] = []
      }
      recordsByType[record.type].push(record)
    })

    // Display records grouped by type
    Object.keys(recordsByType)
      .sort()
      .forEach(type => {
        console.log(`\n${type} Records:`)
        console.log('─'.repeat(80))
        recordsByType[type].forEach(record => {
          const name = record.name || '@'
          const priority = record.priority
            ? ` [Priority: ${record.priority}]`
            : ''
          console.log(
            `  ${name}.${domain} → ${record.value} [TTL: ${record.ttl}]${priority}`
          )
        })
      })

    console.log('\n')
  } catch (error) {
    console.error('Error fetching DNS records:', error)
    throw error
  }
}

main()
