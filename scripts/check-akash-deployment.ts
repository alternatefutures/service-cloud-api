import 'dotenv/config'
import { AkashOrchestrator } from '../src/services/akash/orchestrator'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const dseq = parseInt(process.argv[2] || '25396577', 10)
  
  console.log(`\n🔍 Checking Akash deployment: dseq=${dseq}\n`)
  
  const orchestrator = new AkashOrchestrator(prisma)
  
  try {
    await orchestrator.initialize()
    
    // Get wallet address
    const owner = await orchestrator.getAccountAddress()
    console.log(`Owner: ${owner}`)
    
    // Get balances
    const balances = await orchestrator.getBalances(owner)
    console.log(`Balances:`, balances)
    
    // Check database record
    const deployment = await prisma.akashDeployment.findFirst({
      where: { dseq: BigInt(dseq) },
      include: { service: true }
    })
    
    if (deployment) {
      console.log(`\n📦 Database record:`)
      console.log(`  Status: ${deployment.status}`)
      console.log(`  Provider: ${deployment.provider}`)
      console.log(`  gseq: ${deployment.gseq}, oseq: ${deployment.oseq}`)
      console.log(`  Service URLs:`, deployment.serviceUrls)
      
      if (deployment.provider && deployment.gseq && deployment.oseq) {
        // Try to get services from provider
        console.log(`\n🌐 Checking provider services...`)
        try {
          const services = await orchestrator.getServices(
            owner, 
            dseq, 
            deployment.gseq, 
            deployment.oseq, 
            deployment.provider
          )
          console.log(`Services:`, JSON.stringify(services, null, 2))
        } catch (e: any) {
          console.log(`Failed to get services: ${e.message}`)
        }
        
        // Try to get logs
        console.log(`\n📜 Fetching logs...`)
        try {
          const logs = await orchestrator.getLogs(
            owner,
            dseq,
            deployment.gseq,
            deployment.oseq,
            deployment.provider,
            undefined,
            50
          )
          console.log(`Logs:\n${logs}`)
        } catch (e: any) {
          console.log(`Failed to get logs: ${e.message}`)
        }
      }
    } else {
      console.log(`No deployment found in database for dseq=${dseq}`)
    }
    
  } catch (error) {
    console.error('Error:', error)
  } finally {
    orchestrator.shutdown()
    await prisma.$disconnect()
  }
}

main()
