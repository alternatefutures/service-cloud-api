/**
 * Debug DNS records from OpenProvider
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

  console.log('Fetching DNS records for', DOMAIN)
  const records = await client.listDNSRecords(DOMAIN)

  console.log('\nAll records:')
  records.forEach((r, i) => {
    console.log(`${i+1}. ${r.name || '(root)'} ${r.type} → ${r.value} (TTL: ${r.ttl})`)
  })

  console.log('\nLooking for api and auth CNAME records:')
  const apiRecord = records.find(r => r.name === 'api' && r.type === 'CNAME')
  const authRecord = records.find(r => r.name === 'auth' && r.type === 'CNAME')

  console.log('API:', apiRecord || 'NOT FOUND')
  console.log('Auth:', authRecord || 'NOT FOUND')
}

main().catch(console.error)
