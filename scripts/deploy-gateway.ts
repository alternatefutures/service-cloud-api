/**
 * Deploy Caddy SSL Gateway to Akash Network
 *
 * This gateway provides Let's Encrypt SSL termination for custom domains
 */

import * as fs from 'fs'
import * as path from 'path'

const SDL_PATH = path.join(__dirname, '../gateway/gateway-akash.yaml')

async function main() {
  console.log('\n🚀 Deploying Caddy SSL Gateway to Akash Network\n')
  console.log('=' .repeat(60))

  // Read the SDL
  const sdl = fs.readFileSync(SDL_PATH, 'utf-8')
  console.log('\n📄 SDL loaded from:', SDL_PATH)

  console.log('\n📋 Gateway Configuration:')
  console.log('   • Caddy v2 (Alpine)')
  console.log('   • Let\'s Encrypt automatic SSL')
  console.log('   • Domains: api.alternatefutures.ai, auth.alternatefutures.ai')
  console.log('   • TCP ports: 80 (HTTP), 443 (HTTPS)')

  console.log('\n⚠️  Important: After deployment, you need to:')
  console.log('   1. Get the provider IP/hostname from the deployment')
  console.log('   2. Update DNS A records to point to the gateway IP')
  console.log('   3. Wait for Let\'s Encrypt to issue certificates')

  console.log('\n' + '=' .repeat(60))
  console.log('\nTo deploy, run this SDL using Akash MCP tools or CLI.')
  console.log('\nSDL Content Preview:')
  console.log('-'.repeat(60))
  console.log(sdl.slice(0, 1500) + '...\n')
}

main().catch(console.error)
