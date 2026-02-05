import 'dotenv/config'
import { AkashOrchestrator } from '../src/services/akash/orchestrator'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Starting close-all-deployments script...')
  const orchestrator = new AkashOrchestrator(prisma)
  
  try {
    console.log('Initializing orchestrator...')
    await orchestrator.initialize()
    console.log('Orchestrator initialized')
    
    // Get all active deployments
    const active = await prisma.akashDeployment.findMany({
      where: { status: 'ACTIVE' }
    })
    
    console.log(`Found ${active.length} active deployment(s) to close`)
    
    for (const deployment of active) {
      const dseq = Number(deployment.dseq)
      console.log(`Closing deployment dseq=${dseq}...`)
      
      try {
        await orchestrator.closeDeployment(dseq)
        
        // Update DB
        await prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { status: 'CLOSED', closedAt: new Date() }
        })
        
        console.log(`  ✓ Closed dseq=${dseq}`)
      } catch (err: any) {
        console.log(`  ✗ Failed to close dseq=${dseq}: ${err.message}`)
        
        // Mark as closed in DB anyway if it doesn't exist on chain
        if (err.message.includes('not found') || err.message.includes('does not exist')) {
          await prisma.akashDeployment.update({
            where: { id: deployment.id },
            data: { status: 'CLOSED', closedAt: new Date() }
          })
        }
      }
    }
    
    console.log('Done!')
  } finally {
    await prisma.$disconnect()
    process.exit(0)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
