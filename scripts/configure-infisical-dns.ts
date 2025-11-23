#!/usr/bin/env tsx
/**
 * Configure DNS for Infisical deployment
 * Usage: tsx scripts/configure-infisical-dns.ts
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const DSEQ = '24313428'
const PROVIDER = 'akash1k8wqz7znj8mj783nk0nz30xztnck4r3whj56nf'
const AKASH_NODE = 'https://rpc.akashnet.net:443'
const AKASH_CHAIN_ID = 'akashnet-2'
const DOMAIN = 'alternatefutures.ai'
const SUBDOMAIN = 'secrets'

async function configureInfisicalDNS() {
  const username = process.env.OPENPROVIDER_USERNAME
  const password = process.env.OPENPROVIDER_PASSWORD

  if (!username || !password) {
    console.error(
      'Error: OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD must be set'
    )
    process.exit(1)
  }

  try {
    console.log('=== Infisical DNS Configuration ===')
    console.log(`DSEQ: ${DSEQ}`)
    console.log(`Provider: ${PROVIDER}`)
    console.log(`Subdomain: ${SUBDOMAIN}.${DOMAIN}`)
    console.log('')

    // Step 1: Get provider info
    console.log('Fetching provider info...')
    const { stdout: providerInfo } = await execAsync(
      `akash query provider get ${PROVIDER} --node ${AKASH_NODE} --chain-id ${AKASH_CHAIN_ID} --output json`
    )

    const providerData = JSON.parse(providerInfo)
    const providerUri = providerData.provider?.host_uri || providerData.host_uri

    if (!providerUri) {
      console.error('Provider URI not found')
      process.exit(1)
    }

    console.log(`Provider URI: ${providerUri}`)

    // Step 2: Get lease status from provider
    console.log('Fetching lease status...')
    const leaseStatusUrl = `${providerUri}/lease/${DSEQ}/1/1/status`
    const response = await globalThis.fetch(leaseStatusUrl)

    if (!response.ok) {
      throw new Error(`Provider API error: ${response.status}`)
    }

    const data = (await response.json()) as {
      services?: Record<string, { uris?: string[] }>
      forwarded_ports?: Record<string, Array<{ host: string; port: number }>>
    }

    // Find the Infisical service
    let infisicalUri: string | null = null

    // Check services.uris first
    if (
      data.services?.infisical?.uris &&
      data.services.infisical.uris.length > 0
    ) {
      infisicalUri = data.services.infisical.uris[0]
    }

    // Check forwarded_ports as fallback
    if (!infisicalUri && data.forwarded_ports?.infisical) {
      const ports = data.forwarded_ports.infisical
      if (ports.length > 0) {
        infisicalUri = `http://${ports[0].host}:${ports[0].port}`
      }
    }

    if (!infisicalUri) {
      console.error('Could not find Infisical service in deployment')
      console.log('Lease status:', JSON.stringify(data, null, 2))
      process.exit(1)
    }

    console.log(`Infisical URI: ${infisicalUri}`)

    // Extract CNAME target (hostname without protocol)
    const uriMatch = infisicalUri.match(/^(?:https?:\/\/)?([^:/]+)/)
    if (!uriMatch) {
      console.error('Could not parse Infisical URI')
      process.exit(1)
    }

    const cnameTarget = uriMatch[1]
    console.log(`CNAME target: ${cnameTarget}`)
    console.log('')

    // Step 3: Login to OpenProvider
    console.log('Authenticating with OpenProvider...')
    const loginResponse = await globalThis.fetch(
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

    const loginData = (await loginResponse.json()) as {
      data: { token: string }
    }
    const token = loginData.data.token

    // Step 4: Check if DNS record already exists
    console.log('Checking existing DNS records...')
    const recordsResponse = await globalThis.fetch(
      `https://api.openprovider.eu/v1beta/dns/zones/${DOMAIN}/records`,
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

    const recordsData = (await recordsResponse.json()) as {
      data: {
        results: Array<{
          id: number
          name: string
          type: string
          value: string
          ttl: number
        }>
      }
    }

    const existingRecord = recordsData.data.results.find(
      r => r.name === SUBDOMAIN && r.type === 'CNAME'
    )

    if (existingRecord) {
      console.log(`Found existing CNAME record (ID: ${existingRecord.id})`)
      console.log(`Current value: ${existingRecord.value}`)

      if (existingRecord.value === cnameTarget) {
        console.log('✓ DNS record already points to correct target')
        process.exit(0)
      }

      // Update existing record
      console.log('Updating DNS record...')
      const updateResponse = await globalThis.fetch(
        `https://api.openprovider.eu/v1beta/dns/zones/${DOMAIN}/records/${existingRecord.id}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: SUBDOMAIN,
            type: 'CNAME',
            value: cnameTarget,
            ttl: 300,
          }),
        }
      )

      if (!updateResponse.ok) {
        throw new Error(`Update failed: ${updateResponse.statusText}`)
      }

      console.log('✓ DNS record updated successfully')
    } else {
      // Create new record
      console.log('Creating DNS record...')
      const createResponse = await globalThis.fetch(
        `https://api.openprovider.eu/v1beta/dns/zones/${DOMAIN}/records`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: SUBDOMAIN,
            type: 'CNAME',
            value: cnameTarget,
            ttl: 300,
          }),
        }
      )

      if (!createResponse.ok) {
        const errorText = await createResponse.text()
        throw new Error(
          `Create failed: ${createResponse.statusText} - ${errorText}`
        )
      }

      console.log('✓ DNS record created successfully')
    }

    console.log('')
    console.log('=== Configuration Complete ===')
    console.log(`URL: https://${SUBDOMAIN}.${DOMAIN}`)
    console.log('Note: DNS propagation may take 2-5 minutes')
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

configureInfisicalDNS()
