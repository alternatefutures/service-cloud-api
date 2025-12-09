/**
 * Remove old IP address from DNS records
 *
 * Usage:
 *   OPENPROVIDER_USERNAME=xxx OPENPROVIDER_PASSWORD=xxx npx tsx scripts/remove-old-dns-ip.ts
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'

const OLD_IP = process.env.OLD_IP || '170.75.255.101'
const DOMAIN = process.env.DOMAIN || 'alternatefutures.ai'
const SUBDOMAINS = (process.env.SUBDOMAINS || 'api,auth,secrets').split(',')

async function main() {
  const username = process.env.OPENPROVIDER_USERNAME
  const password = process.env.OPENPROVIDER_PASSWORD

  if (!username || !password) {
    console.error(
      'Error: OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD environment variables are required'
    )
    process.exit(1)
  }

  const client = new OpenProviderClient({ username, password })

  console.log(`\n🗑️  Removing old IP ${OLD_IP} from ${DOMAIN}`)
  console.log('')

  // List all DNS records
  const records = await client.listDNSRecords(DOMAIN)
  console.log(`Found ${records.length} DNS records\n`)

  for (const subdomain of SUBDOMAINS) {
    // Find all A records for this subdomain with the old IP
    const oldRecords = records.filter(
      r => r.name === subdomain && r.type === 'A' && r.value === OLD_IP
    )

    if (oldRecords.length === 0) {
      console.log(`✅ ${subdomain}.${DOMAIN} - no record with old IP found`)
      continue
    }

    for (const record of oldRecords) {
      if (!record.id) {
        console.log(`⚠️  ${subdomain}.${DOMAIN} - record has no ID, skipping`)
        continue
      }

      console.log(
        `🗑️  Deleting ${subdomain}.${DOMAIN} -> ${OLD_IP} (ID: ${record.id})`
      )

      try {
        const result = await client.deleteDNSRecord(DOMAIN, record.id)
        if (result.success) {
          console.log(`✅ Deleted successfully`)
        } else {
          console.log(`❌ Failed: ${result.error}`)
        }
      } catch (error) {
        console.error(
          `❌ Error:`,
          error instanceof Error ? error.message : error
        )
      }
    }
  }

  console.log('\n✨ Cleanup complete!')
}

main().catch(console.error)
