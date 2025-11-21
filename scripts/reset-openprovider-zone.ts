#!/usr/bin/env tsx
/**
 * Reset Openprovider DNS zone (keep only NS and SOA records)
 * Usage: tsx scripts/reset-openprovider-zone.ts <domain>
 *
 * Set CONFIRM=yes to actually reset the zone
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

  console.log(`\n=== Resetting DNS Zone for ${domain} ===\n`)

  const client = new OpenProviderClient(config)

  try {
    // Get current zone
    const zone = await client.request<{
      data: {
        id: number
        name: { extension: string; name: string }
        records: any[]
      }
    }>(`/v1beta/dns/zones/${domain}`)

    console.log(`Current zone ID: ${zone.data.id}`)
    console.log(`Total records: ${zone.data.records?.length || 0}\n`)

    // Keep only NS and SOA records (system records)
    const systemRecords = (zone.data.records || []).filter(
      (r: any) => r.type === 'NS' || r.type === 'SOA'
    )

    console.log(`System records (NS/SOA): ${systemRecords.length}`)
    console.log(
      `User records to remove: ${(zone.data.records?.length || 0) - systemRecords.length}\n`
    )

    if (process.env.CONFIRM !== 'yes') {
      console.log(
        '⚠️  Dry run mode. This would reset the zone to only system records.'
      )
      console.log('Set CONFIRM=yes to actually reset.')
      console.log(
        'Example: CONFIRM=yes tsx scripts/reset-openprovider-zone.ts alternatefutures.ai'
      )
      return
    }

    // Reset zone with only system records
    console.log('🔄 Resetting zone...\n')

    await client.request(`/v1beta/dns/zones/${domain}`, 'PUT', {
      id: zone.data.id,
      name: zone.data.name,
      type: 'master',
      records: systemRecords,
    })

    console.log('✅ Zone reset successfully!\n')
    console.log('The zone now contains only NS and SOA records.')
    console.log(
      'You can now run the migration script to add your DNS records.\n'
    )
  } catch (error) {
    console.error('Error resetting zone:', error)
    throw error
  }
}

main()
