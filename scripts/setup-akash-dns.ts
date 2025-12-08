/**
 * Setup DNS for Akash Deployed Services
 *
 * Creates CNAME records pointing to Akash ingress URLs
 *
 * Usage:
 *   npx tsx scripts/setup-akash-dns.ts
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'
import dotenv from 'dotenv'

dotenv.config()

const DOMAIN = 'alternatefutures.ai'

// Edge node dedicated IP (HAProxy with Let's Encrypt SSL)
// Deployment: dseq 24454690, Provider: dal.leet.haus
// Certificate valid: Dec 2, 2025 - Mar 2, 2026
const EDGE_NODE_IP = '170.75.255.101'

// DNS A records pointing to edge node (updated Dec 2, 2025)
const DNS_RECORDS = [
  {
    subdomain: 'api',
    type: 'A' as const,
    target: EDGE_NODE_IP,
    description: 'API via HAProxy edge node → service-cloud-api'
  },
  {
    subdomain: 'auth',
    type: 'A' as const,
    target: EDGE_NODE_IP,
    description: 'Auth via HAProxy edge node → service-auth'
  }
]

async function main() {
  console.log('\n🌐 Setting up DNS for Akash Edge Node\n')
  console.log('=' .repeat(60))
  console.log(`\n🔒 Edge Node IP: ${EDGE_NODE_IP}`)
  console.log('   HAProxy with Let\'s Encrypt SSL certificate')

  const username = process.env.OPENPROVIDER_USERNAME
  const password = process.env.OPENPROVIDER_PASSWORD

  if (!username || !password) {
    console.error('❌ Missing OpenProvider credentials in .env')
    console.error('   Required: OPENPROVIDER_USERNAME, OPENPROVIDER_PASSWORD')
    process.exit(1)
  }

  const client = new OpenProviderClient({ username, password })

  console.log(`\n📋 Domain: ${DOMAIN}`)
  console.log(`📋 Records to create: ${DNS_RECORDS.length}\n`)

  // First, list existing records
  console.log('📂 Fetching existing DNS records...')
  try {
    const existingRecords = await client.listDNSRecords(DOMAIN)
    console.log(`   Found ${existingRecords.length} existing records`)

    // Check for existing A or CNAME records for our subdomains
    for (const record of DNS_RECORDS) {
      const existingA = existingRecords.find(
        r => r.name === record.subdomain && r.type === 'A'
      )
      const existingCname = existingRecords.find(
        r => r.name === record.subdomain && r.type === 'CNAME'
      )
      if (existingA) {
        console.log(`   ⚠️  Existing A record for ${record.subdomain}: ${existingA.value}`)
      }
      if (existingCname) {
        console.log(`   ⚠️  Existing CNAME for ${record.subdomain}: ${existingCname.value} (will be replaced with A record)`)
      }
    }
  } catch (error) {
    console.error(`   ❌ Failed to fetch records: ${error}`)
  }

  console.log('\n' + '-'.repeat(60))

  // Create/update A records (replace any existing CNAME records)
  for (const record of DNS_RECORDS) {
    console.log(`\n🔧 Setting up ${record.subdomain}.${DOMAIN}`)
    console.log(`   Description: ${record.description}`)
    console.log(`   Type: ${record.type} → ${record.target}`)

    try {
      // Check if record already exists
      const records = await client.listDNSRecords(DOMAIN)
      const existingA = records.find(r =>
        (r.name === record.subdomain || r.name === `${record.subdomain}.${DOMAIN}`) &&
        r.type === 'A'
      )
      const existingCname = records.find(r =>
        (r.name === record.subdomain || r.name === `${record.subdomain}.${DOMAIN}`) &&
        r.type === 'CNAME'
      )

      // If A record exists with correct value, skip
      if (existingA && existingA.value === record.target) {
        console.log(`   ✅ Already configured correctly`)
        continue
      }

      // Get zone info for updates
      const zone = await client.request<{
        data: { id: number; name: { extension: string; name: string } }
      }>(`/v1beta/dns/zones/${DOMAIN}`)

      const recordsToRemove: Array<{ name: string; type: string; value: string; ttl: number }> = []
      const recordsToAdd: Array<{ name: string; type: string; value: string; ttl: number }> = []

      // Remove existing CNAME if present (can't have both CNAME and A for same subdomain)
      if (existingCname) {
        console.log(`   🗑️  Removing existing CNAME: ${existingCname.value}`)
        recordsToRemove.push({
          name: existingCname.name,
          type: 'CNAME',
          value: existingCname.value,
          ttl: existingCname.ttl
        })
      }

      // Remove existing A record if it has wrong value
      if (existingA && existingA.value !== record.target) {
        console.log(`   🗑️  Removing old A record: ${existingA.value}`)
        recordsToRemove.push({
          name: existingA.name,
          type: 'A',
          value: existingA.value,
          ttl: existingA.ttl
        })
      }

      // Add new A record
      if (!existingA || existingA.value !== record.target) {
        recordsToAdd.push({
          name: record.subdomain,
          type: 'A',
          value: record.target,
          ttl: 3600
        })
      }

      // Apply changes
      if (recordsToRemove.length > 0 || recordsToAdd.length > 0) {
        await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
          id: zone.data.id,
          name: zone.data.name,
          records: {
            remove: recordsToRemove,
            add: recordsToAdd,
          },
        })
        console.log(`   ✅ A record configured successfully`)
      }
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.log('\n' + '=' .repeat(60))
  console.log('\n📋 DNS Configuration Summary:\n')

  for (const record of DNS_RECORDS) {
    console.log(`   ${record.subdomain}.${DOMAIN}`)
    console.log(`   └─ ${record.type} → ${record.target}`)
    console.log(`   └─ ${record.description}\n`)
  }

  console.log('🔒 Edge Node Details:')
  console.log(`   IP: ${EDGE_NODE_IP}`)
  console.log('   SSL: Let\'s Encrypt (valid Dec 2, 2025 - Mar 2, 2026)')
  console.log('   Protocol: HTTP/2 + TLSv1.3')
  console.log('')
  console.log('⏳ DNS propagation may take up to 24 hours.')
  console.log('   You can verify with: dig A api.alternatefutures.ai\n')
}

main().catch(console.error)
