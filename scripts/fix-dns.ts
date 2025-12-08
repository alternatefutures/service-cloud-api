/**
 * Fix DNS records - remove duplicates and update correctly
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'
import dotenv from 'dotenv'

dotenv.config()

const DOMAIN = 'alternatefutures.ai'

const CORRECT_RECORDS = {
  'api.alternatefutures.ai': 'cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com',
  'auth.alternatefutures.ai': 'uilm2birnle5b7ffcqvsgpolc4.ingress.europlots.com',
}

async function main() {
  const client = new OpenProviderClient({
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  })

  console.log('Fetching current DNS records...')
  const records = await client.listDNSRecords(DOMAIN)

  // Find records to remove (old targets and duplicates)
  const toRemove = records.filter(r => {
    if (r.type !== 'CNAME') return false
    // Remove duplicated domain names
    if (r.name.endsWith('.alternatefutures.ai.alternatefutures.ai')) return true
    // Remove old api/auth records with wrong targets
    if (r.name === 'api.alternatefutures.ai' && r.value !== CORRECT_RECORDS['api.alternatefutures.ai']) return true
    if (r.name === 'auth.alternatefutures.ai' && r.value !== CORRECT_RECORDS['auth.alternatefutures.ai']) return true
    return false
  })

  // Find records to add
  const existingNames = records.map(r => r.name)
  const toAdd: { name: string; type: string; value: string; ttl: number }[] = []

  for (const [name, value] of Object.entries(CORRECT_RECORDS)) {
    const existing = records.find(r => r.name === name && r.type === 'CNAME' && r.value === value)
    if (!existing) {
      toAdd.push({ name, type: 'CNAME', value, ttl: 3600 })
    }
  }

  console.log('\nRecords to remove:', toRemove.length)
  toRemove.forEach(r => console.log(`  - ${r.name} → ${r.value}`))

  console.log('\nRecords to add:', toAdd.length)
  toAdd.forEach(r => console.log(`  + ${r.name} → ${r.value}`))

  if (toRemove.length === 0 && toAdd.length === 0) {
    console.log('\n✅ DNS is already configured correctly')
    return
  }

  // Get zone info
  const zone = await client.request<{
    data: { id: number; name: { extension: string; name: string } }
  }>(`/v1beta/dns/zones/${DOMAIN}`)

  // Remove old records first
  if (toRemove.length > 0) {
    console.log('\nRemoving old records...')
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        remove: toRemove.map(r => ({ name: r.name, type: r.type, value: r.value, ttl: r.ttl })),
      },
    })
    console.log('  ✅ Old records removed')
  }

  // Add new records
  if (toAdd.length > 0) {
    console.log('\nAdding new records...')
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        add: toAdd,
      },
    })
    console.log('  ✅ New records added')
  }

  console.log('\n✅ DNS updated successfully!')

  // Verify
  console.log('\nVerifying...')
  const newRecords = await client.listDNSRecords(DOMAIN)
  const cnameRecords = newRecords.filter(r => r.type === 'CNAME' && (r.name.includes('api') || r.name.includes('auth')))
  cnameRecords.forEach(r => console.log(`  ${r.name} → ${r.value}`))
}

main().catch(console.error)
