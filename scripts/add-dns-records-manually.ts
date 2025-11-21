#!/usr/bin/env tsx
/**
 * Manually add DNS records to Openprovider
 * This bypasses the migration and adds records directly
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'
import type { DNSRecord } from '../src/services/dns/types.js'

const RECORDS_TO_ADD: Omit<DNSRecord, 'id'>[] = [
  // CNAME records
  { name: 'api', type: 'CNAME', value: '6xwsvzys.up.railway.app.', ttl: 1799 },
  { name: 'deck', type: 'CNAME', value: 'sites.gamma.app.', ttl: 1799 },
  {
    name: 'www',
    type: 'CNAME',
    value: 'cme1snlpz00011f42oza4jk4c.fleekcdn.xyz.',
    ttl: 1799,
  },
  { name: '61903975', type: 'CNAME', value: 'google.com.', ttl: 3600 },

  // MX records
  { name: '', type: 'MX', value: 'SMTP.GOOGLE.COM.', ttl: 600, priority: 10 },
  {
    name: 'send.updates',
    type: 'MX',
    value: 'feedback-smtp.us-east-1.amazonses.com.',
    ttl: 1799,
    priority: 10,
  },

  // TXT records
  {
    name: '',
    type: 'TXT',
    value:
      'google-site-verification=5vD8aEkSXwV6PpyvT3JyLxRymcqJqwyQ-K98ZaXQGLk',
    ttl: 600,
  },
  { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none;', ttl: 1799 },
  {
    name: 'resend._domainkey.updates',
    type: 'TXT',
    value:
      'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCc8rOazc2u9nz2qshZnFRvpqcSYgzaDVVDwG8AF2RlNTkMWwyvo9P++4RWXWyngWKZ+Ytk9c19+oTmO7dlvoMjbC61i5kEb5VXlKWaTC3eZwtf/aDstG84uCzYRVMkHz8lJW2fv6JaW1TV9+BukXPrcbgZvbuzWCwIPK6FzrkjiQIDAQAB',
    ttl: 1799,
  },
  {
    name: 'send.updates',
    type: 'TXT',
    value: 'v=spf1 include:amazonses.com ~all',
    ttl: 1799,
  },
]

async function main() {
  const domain = 'alternatefutures.ai'

  const config = {
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  }

  if (!config.username || !config.password) {
    throw new Error('Missing Openprovider credentials')
  }

  console.log(`\n=== Adding DNS Records to ${domain} ===\n`)
  console.log(`Records to add: ${RECORDS_TO_ADD.length}\n`)

  if (process.env.CONFIRM !== 'yes') {
    console.log('📋 Records that would be added:\n')
    RECORDS_TO_ADD.forEach(r => {
      const name = r.name || '@'
      const priority = r.priority ? ` [Priority: ${r.priority}]` : ''
      console.log(`  ${name} (${r.type}) → ${r.value}${priority}`)
    })
    console.log(
      '\n⚠️  Dry run mode. Set CONFIRM=yes to actually add these records.'
    )
    console.log('Example: CONFIRM=yes tsx scripts/add-dns-records-manually.ts')
    return
  }

  const client = new OpenProviderClient(config)

  let successCount = 0
  let failureCount = 0

  for (const record of RECORDS_TO_ADD) {
    try {
      const result = await client.createDNSRecord(domain, record)
      if (result.success) {
        successCount++
        const name = record.name || '@'
        console.log(`✓ Created: ${name} (${record.type}) → ${record.value}`)
      } else {
        failureCount++
        console.error(`✗ Failed: ${record.name || '@'} - ${result.error}`)
      }
    } catch (error) {
      failureCount++
      console.error(`✗ Failed: ${record.name || '@'} - ${error}`)
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  console.log(
    `\n✅ Complete: ${successCount} succeeded, ${failureCount} failed\n`
  )
}

main()
