#!/usr/bin/env tsx
/**
 * Check DNS records in OpenProvider
 */

import { config } from 'dotenv'

// Load .env file
config()

async function checkDNS() {
  const username = process.env.OPENPROVIDER_USERNAME
  const password = process.env.OPENPROVIDER_PASSWORD
  const domain = 'alternatefutures.ai'

  if (!username || !password) {
    console.error(
      'Error: OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD must be set'
    )
    process.exit(1)
  }

  try {
    // Login to get token
    console.log('Authenticating with OpenProvider...')
    const loginResponse = await fetch(
      'https://api.openprovider.eu/v1beta/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }
    )

    if (!loginResponse.ok) {
      throw new Error(`Login failed: ${loginResponse.statusText}`)
    }

    const loginData = await loginResponse.json()
    const token = loginData.data.token

    console.log('Fetching DNS records for', domain, '...\n')

    // Get DNS zone records
    const recordsResponse = await fetch(
      `https://api.openprovider.eu/v1beta/dns/zones/${domain}/records`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!recordsResponse.ok) {
      throw new Error(`Failed to fetch records: ${recordsResponse.statusText}`)
    }

    const recordsData = await recordsResponse.json()
    const records = recordsData.data.results

    // Filter for secrets subdomain
    const secretsRecords = records.filter(
      (r: any) =>
        r.name === 'secrets' || r.name === 'secrets.alternatefutures.ai'
    )

    if (secretsRecords.length === 0) {
      console.log('❌ No DNS record found for secrets.alternatefutures.ai')
      console.log(
        '\nThe DNS sync step likely failed or was skipped during deployment.'
      )
    } else {
      console.log('✅ Found DNS record(s) for secrets.alternatefutures.ai:\n')
      secretsRecords.forEach((record: any) => {
        console.log(`  Type: ${record.type}`)
        console.log(`  Name: ${record.name}`)
        console.log(`  Value: ${record.value}`)
        console.log(`  TTL: ${record.ttl}`)
        console.log('')
      })
      console.log(
        'DNS record exists in OpenProvider. It may just need time to propagate.'
      )
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

checkDNS()
