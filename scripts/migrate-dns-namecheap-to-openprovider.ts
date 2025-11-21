#!/usr/bin/env tsx
/**
 * Migrate DNS from Namecheap to Openprovider
 * Usage: tsx scripts/migrate-dns-namecheap-to-openprovider.ts <domain>
 *
 * Prerequisites:
 * - NAMECHEAP_API_USER environment variable
 * - NAMECHEAP_API_KEY environment variable
 * - NAMECHEAP_USERNAME environment variable
 * - OPENPROVIDER_USERNAME environment variable
 * - OPENPROVIDER_PASSWORD environment variable
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'
import type { DNSRecord } from '../src/services/dns/types.js'

interface NamecheapRecord {
  Type: string
  Name: string
  Address: string
  TTL: string
  MXPref?: string
}

interface NamecheapResponse {
  DomainDNSGetHostsResult: {
    host: NamecheapRecord[]
  }
}

async function getNamecheapRecords(domain: string): Promise<DNSRecord[]> {
  const apiUser = process.env.NAMECHEAP_API_USER
  const apiKey = process.env.NAMECHEAP_API_KEY
  const username = process.env.NAMECHEAP_USERNAME
  const clientIp = process.env.NAMECHEAP_CLIENT_IP || '0.0.0.0'

  if (!apiUser || !apiKey || !username) {
    throw new Error(
      'Missing Namecheap credentials: NAMECHEAP_API_USER, NAMECHEAP_API_KEY, NAMECHEAP_USERNAME'
    )
  }

  // Split domain into SLD and TLD
  const parts = domain.split('.')
  const tld = parts.pop()
  const sld = parts.join('.')

  const url = new URL('https://api.namecheap.com/xml.response')
  url.searchParams.set('ApiUser', apiUser)
  url.searchParams.set('ApiKey', apiKey)
  url.searchParams.set('UserName', username)
  url.searchParams.set('ClientIp', clientIp)
  url.searchParams.set('Command', 'namecheap.domains.dns.getHosts')
  url.searchParams.set('SLD', sld)
  url.searchParams.set('TLD', tld!)

  console.log(`Fetching DNS records from Namecheap for ${domain}...`)

  const response = await fetch(url.toString())
  const xml = await response.text()

  // Parse XML response (simple parsing - in production use a proper XML parser)
  const records: DNSRecord[] = []
  const hostMatches = xml.matchAll(
    /<host\s+HostId="(\d+)"\s+Name="([^"]+)"\s+Type="([^"]+)"\s+Address="([^"]+)"\s+MXPref="([^"]+)"\s+TTL="([^"]+)"/g
  )

  for (const match of hostMatches) {
    const [, , name, type, address, mxPref, ttl] = match
    records.push({
      name: name === '@' ? '' : name,
      type: type as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT',
      value: address,
      ttl: parseInt(ttl),
      priority: type === 'MX' ? parseInt(mxPref) : undefined,
    })
  }

  console.log(`Found ${records.length} DNS records on Namecheap`)
  return records
}

async function updateNamecheapNameservers(
  domain: string,
  nameservers: string[]
): Promise<void> {
  const apiUser = process.env.NAMECHEAP_API_USER
  const apiKey = process.env.NAMECHEAP_API_KEY
  const username = process.env.NAMECHEAP_USERNAME
  const clientIp = process.env.NAMECHEAP_CLIENT_IP || '0.0.0.0'

  if (!apiUser || !apiKey || !username) {
    throw new Error('Missing Namecheap credentials')
  }

  const parts = domain.split('.')
  const tld = parts.pop()
  const sld = parts.join('.')

  const url = new URL('https://api.namecheap.com/xml.response')
  url.searchParams.set('ApiUser', apiUser)
  url.searchParams.set('ApiKey', apiKey)
  url.searchParams.set('UserName', username)
  url.searchParams.set('ClientIp', clientIp)
  url.searchParams.set('Command', 'namecheap.domains.dns.setCustom')
  url.searchParams.set('SLD', sld)
  url.searchParams.set('TLD', tld!)
  nameservers.forEach((ns, index) => {
    url.searchParams.set(`Nameservers`, ns)
  })

  console.log(`Updating Namecheap nameservers to Openprovider...`)
  const response = await fetch(url.toString())
  const xml = await response.text()

  if (xml.includes('Status="ERROR"')) {
    throw new Error('Failed to update Namecheap nameservers: ' + xml)
  }

  console.log('Namecheap nameservers updated successfully!')
}

async function migrateToOpenprovider(
  domain: string,
  records: DNSRecord[]
): Promise<void> {
  const config = {
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  }

  if (!config.username || !config.password) {
    throw new Error(
      'Missing Openprovider credentials: OPENPROVIDER_USERNAME, OPENPROVIDER_PASSWORD'
    )
  }

  const client = new OpenProviderClient(config)

  console.log(`\nMigrating ${records.length} DNS records to Openprovider...`)

  let successCount = 0
  let failureCount = 0

  for (const record of records) {
    try {
      const result = await client.createDNSRecord(domain, record)
      if (result.success) {
        successCount++
        console.log(
          `✓ Created: ${record.name || '@'}.${domain} (${record.type}) -> ${record.value}`
        )
      } else {
        failureCount++
        console.error(
          `✗ Failed: ${record.name || '@'}.${domain} - ${result.error}`
        )
      }
    } catch (error) {
      failureCount++
      console.error(`✗ Failed: ${record.name || '@'}.${domain} - ${error}`)
    }

    // Rate limiting - wait 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  console.log(
    `\nMigration complete: ${successCount} succeeded, ${failureCount} failed`
  )

  if (failureCount > 0) {
    console.warn(
      '\nSome records failed to migrate. Please review and manually create them if needed.'
    )
  }
}

async function main() {
  const domain = process.argv[2]

  if (!domain) {
    console.error(
      'Usage: tsx scripts/migrate-dns-namecheap-to-openprovider.ts <domain>'
    )
    console.error(
      'Example: tsx scripts/migrate-dns-namecheap-to-openprovider.ts alternatefutures.ai'
    )
    process.exit(1)
  }

  console.log('=== DNS Migration: Namecheap → Openprovider ===')
  console.log(`Domain: ${domain}\n`)

  try {
    // Step 1: Get records from Namecheap
    const records = await getNamecheapRecords(domain)

    // Step 2: Display records for review
    console.log('\n=== Records to Migrate ===')
    records.forEach(record => {
      console.log(
        `  ${record.name || '@'}.${domain} (${record.type}) -> ${record.value} [TTL: ${record.ttl}]`
      )
    })

    // Step 3: Confirm migration
    console.log('\n=== Confirmation ===')
    console.log('This will:')
    console.log('1. Create all DNS records in Openprovider')
    console.log('2. Update Namecheap nameservers to point to Openprovider')
    console.log('\nProceed? (Set CONFIRM=yes to proceed)')

    if (process.env.CONFIRM !== 'yes') {
      console.log('\nDry run complete. Set CONFIRM=yes to actually migrate.')
      console.log(
        'Example: CONFIRM=yes tsx scripts/migrate-dns-namecheap-to-openprovider.ts alternatefutures.ai'
      )
      process.exit(0)
    }

    // Step 4: Migrate to Openprovider
    await migrateToOpenprovider(domain, records)

    // Step 5: Update Namecheap nameservers
    const openproviderNS = [
      'ns1.openprovider.nl',
      'ns2.openprovider.be',
      'ns3.openprovider.eu',
    ]

    await updateNamecheapNameservers(domain, openproviderNS)

    console.log('\n=== Migration Complete ===')
    console.log('DNS records have been migrated to Openprovider')
    console.log('Namecheap nameservers updated to:')
    openproviderNS.forEach(ns => console.log(`  - ${ns}`))
    console.log('\nDNS propagation may take 24-48 hours.')
  } catch (error) {
    console.error('\nMigration failed:', error)
    process.exit(1)
  }
}

main()
