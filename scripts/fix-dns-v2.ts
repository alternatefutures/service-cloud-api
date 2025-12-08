/**
 * Fix DNS records - remove one at a time
 */

import { OpenProviderClient } from '../src/services/dns/openProviderClient.js'
import dotenv from 'dotenv'

dotenv.config()

const DOMAIN = 'alternatefutures.ai'

async function main() {
  const client = new OpenProviderClient({
    username: process.env.OPENPROVIDER_USERNAME!,
    password: process.env.OPENPROVIDER_PASSWORD!,
  })

  // Get zone info
  const zone = await client.request<{
    data: { id: number; name: { extension: string; name: string } }
  }>(`/v1beta/dns/zones/${DOMAIN}`)

  console.log('Zone ID:', zone.data.id)
  console.log('Zone name:', zone.data.name)

  // Fetch records
  console.log('\nFetching records...')
  const records = await client.listDNSRecords(DOMAIN)

  const cnameRecords = records.filter(r => r.type === 'CNAME')
  console.log('\nCNAME records:')
  cnameRecords.forEach((r, i) => {
    console.log(`  ${i+1}. ${JSON.stringify(r)}`)
  })

  // Remove the bad duplicate records first
  const duplicates = cnameRecords.filter(r => r.name.includes('.alternatefutures.ai.alternatefutures.ai'))
  console.log('\nRemoving', duplicates.length, 'duplicate records...')

  for (const dup of duplicates) {
    try {
      console.log(`  Removing: ${dup.name}`)
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          remove: [{ name: dup.name, type: dup.type, value: dup.value, ttl: dup.ttl }],
        },
      })
      console.log('    ✅ Removed')
    } catch (error) {
      console.log(`    ❌ Error: ${error}`)
    }
  }

  // Now update the api and auth records
  console.log('\nUpdating api and auth records...')

  // First get fresh records
  const freshRecords = await client.listDNSRecords(DOMAIN)
  const apiRecord = freshRecords.find(r => r.name === 'api.alternatefutures.ai' && r.type === 'CNAME')
  const authRecord = freshRecords.find(r => r.name === 'auth.alternatefutures.ai' && r.type === 'CNAME')

  // Update API
  if (apiRecord && apiRecord.value !== 'cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com') {
    console.log(`\nUpdating API record from ${apiRecord.value}`)
    try {
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          remove: [{ name: apiRecord.name, type: 'CNAME', value: apiRecord.value, ttl: apiRecord.ttl }],
        },
      })
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          add: [{ name: 'api.alternatefutures.ai', type: 'CNAME', value: 'cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com', ttl: 3600 }],
        },
      })
      console.log('  ✅ API record updated')
    } catch (error) {
      console.log(`  ❌ Error: ${error}`)
    }
  } else if (!apiRecord) {
    console.log('\nCreating API record...')
    try {
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          add: [{ name: 'api.alternatefutures.ai', type: 'CNAME', value: 'cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com', ttl: 3600 }],
        },
      })
      console.log('  ✅ API record created')
    } catch (error) {
      console.log(`  ❌ Error: ${error}`)
    }
  } else {
    console.log('\n✅ API record already correct')
  }

  // Update Auth
  if (authRecord && authRecord.value !== 'uilm2birnle5b7ffcqvsgpolc4.ingress.europlots.com') {
    console.log(`\nUpdating Auth record from ${authRecord.value}`)
    try {
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          remove: [{ name: authRecord.name, type: 'CNAME', value: authRecord.value, ttl: authRecord.ttl }],
        },
      })
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          add: [{ name: 'auth.alternatefutures.ai', type: 'CNAME', value: 'uilm2birnle5b7ffcqvsgpolc4.ingress.europlots.com', ttl: 3600 }],
        },
      })
      console.log('  ✅ Auth record updated')
    } catch (error) {
      console.log(`  ❌ Error: ${error}`)
    }
  } else if (!authRecord) {
    console.log('\nCreating Auth record...')
    try {
      await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          add: [{ name: 'auth.alternatefutures.ai', type: 'CNAME', value: 'uilm2birnle5b7ffcqvsgpolc4.ingress.europlots.com', ttl: 3600 }],
        },
      })
      console.log('  ✅ Auth record created')
    } catch (error) {
      console.log(`  ❌ Error: ${error}`)
    }
  } else {
    console.log('\n✅ Auth record already correct')
  }

  // Final verification
  console.log('\n\nFinal verification:')
  const finalRecords = await client.listDNSRecords(DOMAIN)
  finalRecords.filter(r => r.type === 'CNAME' && (r.name.includes('api') || r.name.includes('auth')))
    .forEach(r => console.log(`  ${r.name} → ${r.value}`))
}

main().catch(console.error)
