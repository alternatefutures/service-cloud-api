import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { getAkashOrchestrator } from '../src/services/akash/orchestrator.js'

const prisma = new PrismaClient()

const MODE = process.argv[2] || 'check' // 'check' or 'close-all'

async function main() {
  const orchestrator = getAkashOrchestrator(prisma)

  console.log('=== Akash Wallet & Deployments ===\n')
  console.log(`Mode: ${MODE}\n`)
  
  // Start the MCP process
  console.log('Starting MCP process...')
  await orchestrator.start()
  console.log('MCP started\n')

  // Get account address
  let address: string | null = null
  try {
    address = await orchestrator.getAccountAddress()
    console.log('Wallet address:', address)
  } catch (e: any) {
    console.log('Error getting address:', e.message)
  }

  // Check wallet balance
  if (address) {
    try {
      const balances = await orchestrator.getBalances(address)
      const aktBalance = balances.find((b: any) => b.denom === 'uakt')
      const aktAmount = aktBalance ? parseInt(aktBalance.amount) / 1_000_000 : 0
      console.log(`💰 AKT balance: ${aktAmount.toFixed(6)} AKT\n`)
    } catch (e: any) {
      console.log('Error getting balance:', e.message)
    }
  }

  // Get all non-closed deployments from DB
  const deployments = await prisma.akashDeployment.findMany({
    where: { status: { not: 'CLOSED' } },
    include: { service: true },
    orderBy: { createdAt: 'desc' }
  })

  console.log(`=== Deployments (${deployments.length} non-closed in DB) ===`)
  
  if (deployments.length === 0) {
    console.log('No active deployments found')
  } else {
    for (const d of deployments) {
      console.log(`  - dseq: ${d.dseq}, status: ${d.status}, service: ${d.service?.name || 'unknown'}`)
    }
  }

  // Close all deployments if mode is 'close-all'
  if (MODE === 'close-all' && deployments.length > 0) {
    console.log('\n=== Closing All Deployments ===')
    
    for (const d of deployments) {
      console.log(`\nClosing dseq=${d.dseq}...`)
      try {
        await orchestrator.closeDeployment(Number(d.dseq))
        await prisma.akashDeployment.update({
          where: { id: d.id },
          data: { status: 'CLOSED', closedAt: new Date() }
        })
        console.log(`  ✓ Closed on chain and DB`)
      } catch (e: any) {
        console.log(`  ✗ Chain error: ${e.message}`)
        // Mark as closed in DB anyway (might already be closed on chain)
        await prisma.akashDeployment.update({
          where: { id: d.id },
          data: { status: 'CLOSED', closedAt: new Date() }
        })
        console.log(`  → Marked as CLOSED in DB`)
      }
    }

    // Check balance after closing
    if (address) {
      console.log('\n=== Balance After Closing ===')
      try {
        const balances = await orchestrator.getBalances(address)
        const aktBalance = balances.find((b: any) => b.denom === 'uakt')
        const aktAmount = aktBalance ? parseInt(aktBalance.amount) / 1_000_000 : 0
        console.log(`💰 AKT balance: ${aktAmount.toFixed(6)} AKT`)
      } catch (e: any) {
        console.log('Error getting balance:', e.message)
      }
    }
  }

  // Stop MCP process
  orchestrator.stop()
  
  await prisma.$disconnect()
}

main().catch(console.error)
