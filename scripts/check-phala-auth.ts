#!/usr/bin/env npx tsx
/**
 * Test Phala Cloud API connection.
 * Requires PHALA_API_KEY in .env (or environment).
 *
 * Uses the main `phala` CLI (npm package "phala"), which supports
 * PHALA_CLOUD_API_KEY env var for auth.
 *
 * Usage: npx tsx scripts/check-phala-auth.ts
 */
import 'dotenv/config'
import { execSync } from 'child_process'

const PHALA_API_KEY = process.env.PHALA_API_KEY

async function main() {
  if (!PHALA_API_KEY || PHALA_API_KEY.trim() === '') {
    console.error('❌ PHALA_API_KEY is not set. Add it to .env or env.')
    process.exit(1)
  }

  console.log('Testing Phala Cloud API connection...\n')

  try {
    // Use phala package (not @phala/phala-cli) - it reads PHALA_CLOUD_API_KEY
    const env = { ...process.env, PHALA_CLOUD_API_KEY: PHALA_API_KEY }

    // Check status (validates API key)
    console.log('1. Checking auth status...')
    const statusOut = execSync('npx phala status --json', {
      stdio: 'pipe',
      encoding: 'utf-8',
      env,
    })
    const status = JSON.parse(statusOut)
    console.log('   ✓ Auth status:', JSON.stringify(status, null, 2))

    // List CVMs (confirms API works)
    console.log('\n2. Listing CVMs...')
    const listOut = execSync('npx phala cvms list --json', {
      stdio: 'pipe',
      encoding: 'utf-8',
      env,
    })
    const cvms = JSON.parse(listOut)
    const count = Array.isArray(cvms) ? cvms.length : (cvms?.items?.length ?? 0)
    console.log(`   ✓ Found ${count} CVM(s)`)

    console.log('\n✅ Phala API connection OK')
  } catch (err: any) {
    console.error('\n❌ Phala API connection failed:', err.message)
    if (err.stdout) console.error('stdout:', err.stdout)
    if (err.stderr) console.error('stderr:', err.stderr)
    process.exit(1)
  }
}

main()
