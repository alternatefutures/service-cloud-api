/**
 * Fix DNS records - try using short subdomain names
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

  // Try removing with short name
  console.log('\nTrying to remove old api record with short name...')
  try {
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        remove: [{ name: 'api', type: 'CNAME', value: '9fsk6t78spej915l3he2ejq1jg.ingress.europlots.com', ttl: 3600 }],
      },
    })
    console.log('  ✅ Removed')
  } catch (error: unknown) {
    console.log(`  ❌ Error: ${error instanceof Error ? error.message : error}`)
  }

  // Now add with short name
  console.log('\nTrying to add new api record with short name...')
  try {
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        add: [{ name: 'api', type: 'CNAME', value: 'cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com', ttl: 3600 }],
      },
    })
    console.log('  ✅ Added')
  } catch (error: unknown) {
    console.log(`  ❌ Error: ${error instanceof Error ? error.message : error}`)
  }

  // Auth
  console.log('\nTrying to remove old auth record with short name...')
  try {
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        remove: [{ name: 'auth', type: 'CNAME', value: 'irqnjdusb9c813k10bl2gd92l0.ingress.europlots.com', ttl: 3600 }],
      },
    })
    console.log('  ✅ Removed')
  } catch (error: unknown) {
    console.log(`  ❌ Error: ${error instanceof Error ? error.message : error}`)
  }

  console.log('\nTrying to add new auth record with short name...')
  try {
    await client.request(`/v1beta/dns/zones/${DOMAIN}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      records: {
        add: [{ name: 'auth', type: 'CNAME', value: 'uilm2birnle5b7ffcqvsgpolc4.ingress.europlots.com', ttl: 3600 }],
      },
    })
    console.log('  ✅ Added')
  } catch (error: unknown) {
    console.log(`  ❌ Error: ${error instanceof Error ? error.message : error}`)
  }

  // Verify
  console.log('\nVerifying:')
  const records = await client.listDNSRecords(DOMAIN)
  records.filter(r => r.type === 'CNAME' && (r.name.includes('api') || r.name.includes('auth')))
    .forEach(r => console.log(`  ${r.name} → ${r.value}`))
}

main().catch(console.error)
