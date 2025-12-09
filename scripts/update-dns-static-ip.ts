/**
 * Update DNS records to point to Caddy Edge Proxy static IP
 *
 * Usage:
 *   OPENPROVIDER_USERNAME=xxx OPENPROVIDER_PASSWORD=xxx npx tsx scripts/update-dns-static-ip.ts
 *
 * Environment Variables:
 *   OPENPROVIDER_USERNAME - Required
 *   OPENPROVIDER_PASSWORD - Required
 *   STATIC_IP - Optional, defaults to 62.3.50.131
 *   SUBDOMAINS - Optional, comma-separated, defaults to api,auth,secrets
 *   DOMAIN - Optional, defaults to alternatefutures.ai
 */

import { DNSManager } from '../src/services/dns/dnsManager.js'

const STATIC_IP = process.env.STATIC_IP || '62.3.50.131'
const DOMAIN = process.env.DOMAIN || 'alternatefutures.ai'
const SUBDOMAINS = (process.env.SUBDOMAINS || 'api,auth,secrets').split(',')

async function main() {
  const username = process.env.OPENPROVIDER_USERNAME
  const password = process.env.OPENPROVIDER_PASSWORD

  if (!username || !password) {
    console.error(
      'Error: OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD environment variables are required'
    )
    console.error('')
    console.error('Usage:')
    console.error(
      '  OPENPROVIDER_USERNAME=xxx OPENPROVIDER_PASSWORD=xxx npx tsx scripts/update-dns-static-ip.ts'
    )
    process.exit(1)
  }

  const dnsManager = new DNSManager(
    { username, password },
    DOMAIN,
    600 // 10 minute TTL (OpenProvider minimum)
  )

  console.log(`\n🌐 Updating DNS records for ${DOMAIN}`)
  console.log(`📍 Target IP: ${STATIC_IP}`)
  console.log('')

  for (const subdomain of SUBDOMAINS) {
    console.log(`\n📝 Processing ${subdomain}.${DOMAIN}...`)

    try {
      const result = await dnsManager.ensureSubdomain(subdomain, STATIC_IP)

      if (result.success) {
        console.log(`✅ ${subdomain}.${DOMAIN} -> ${STATIC_IP}`)
      } else {
        console.error(`❌ Failed to update ${subdomain}: ${result.error}`)
      }
    } catch (error) {
      console.error(`❌ Error updating ${subdomain}:`)
      if (error instanceof Error) {
        console.error(`   Message: ${error.message}`)
        // Log more details for debugging
        if (error.message.includes('Internal Server Error')) {
          console.error('   Possible causes:')
          console.error('   - Invalid OpenProvider credentials')
          console.error('   - API rate limiting')
          console.error('   - OpenProvider service outage')
        }
      } else {
        console.error('   ', error)
      }
    }
  }

  console.log('\n🔍 Verifying DNS propagation...')

  for (const subdomain of SUBDOMAINS) {
    const check = await dnsManager.verifyDNSPropagation(subdomain, STATIC_IP)
    if (check.healthy) {
      console.log(
        `✅ ${subdomain}.${DOMAIN} resolved correctly to ${STATIC_IP}`
      )
    } else {
      console.log(
        `⏳ ${subdomain}.${DOMAIN} currently resolves to ${check.currentIP || 'N/A'} (propagation in progress)`
      )
    }
  }

  console.log('\n✨ DNS update complete!')
  console.log(
    'Note: DNS propagation may take 5-30 minutes to complete globally.'
  )
}

main().catch(console.error)
