import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface ArnsConfig {
  arweaveNodeUrl?: string
  walletJwk?: any // Arweave wallet JWK
}

export interface ArnsRecord {
  name: string
  transactionId: string
  contentId: string
  ttl?: number
}

/**
 * Register an ArNS name for a domain
 * ArNS (Arweave Name System) allows mapping human-readable names to Arweave content
 */
export async function registerArnsName(
  domainId: string,
  arnsName: string,
  contentId: string,
  config: ArnsConfig
): Promise<ArnsRecord> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  try {
    // Initialize Arweave client
    // const Arweave = require('arweave');
    // const arweave = Arweave.init({
    //   host: config.arweaveNodeUrl || 'arweave.net',
    //   port: 443,
    //   protocol: 'https'
    // });

    // Create ArNS registration transaction
    // This would typically involve:
    // 1. Creating a transaction with ArNS contract
    // 2. Signing with wallet
    // 3. Submitting to Arweave network

    // Placeholder for actual ArNS registration
    const transactionId = `mock-arns-tx-${Date.now()}`

    // Update domain with ArNS information
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        arnsName,
        arnsTransactionId: transactionId,
        domainType: 'ARNS',
        verified: true, // ArNS registration implies verification
        dnsVerifiedAt: new Date(),
      },
    })

    return {
      name: arnsName,
      transactionId,
      contentId,
    }
  } catch (error) {
    throw new Error(
      `ArNS registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Update ArNS record to point to new content
 */
export async function updateArnsRecord(
  domainId: string,
  newContentId: string,
  config: ArnsConfig
): Promise<ArnsRecord> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  if (!domain.arnsName) {
    throw new Error('Domain does not have an ArNS name registered')
  }

  try {
    // Update ArNS record on Arweave
    // This would create a new transaction updating the ArNS mapping
    const transactionId = `mock-arns-update-tx-${Date.now()}`

    // Update domain record
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        arnsTransactionId: transactionId,
      },
    })

    return {
      name: domain.arnsName,
      transactionId,
      contentId: newContentId,
    }
  } catch (error) {
    throw new Error(
      `ArNS update failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Resolve ArNS name to content ID
 */
export async function resolveArnsName(
  arnsName: string,
  config: ArnsConfig
): Promise<string | null> {
  try {
    // Query ArNS contract to get current content ID for the name
    // This would involve reading from Arweave smart contract

    // Placeholder implementation
    const domain = await prisma.domain.findFirst({
      where: { arnsName },
    })

    if (!domain) {
      return null
    }

    // In real implementation, this would be the Arweave transaction ID
    // that the ArNS name points to
    return domain.arnsTransactionId
  } catch (error) {
    console.error('ArNS resolution failed:', error)
    return null
  }
}

/**
 * Check if ArNS name is available
 */
export async function checkArnsAvailability(
  arnsName: string,
  config: ArnsConfig
): Promise<boolean> {
  try {
    // Query ArNS registry to check if name is taken
    const existing = await prisma.domain.findFirst({
      where: { arnsName },
    })

    return !existing
  } catch (error) {
    console.error('ArNS availability check failed:', error)
    return false
  }
}

/**
 * Get ArNS record details
 */
export async function getArnsRecord(
  arnsName: string,
  config: ArnsConfig
): Promise<ArnsRecord | null> {
  try {
    const domain = await prisma.domain.findFirst({
      where: { arnsName },
      include: {
        site: {
          include: { deployments: { take: 1, orderBy: { createdAt: 'desc' } } },
        },
      },
    })

    if (!domain || !domain.arnsTransactionId || !domain.arnsName) {
      return null
    }

    // Get latest deployment CID as content ID
    const contentId = domain.site.deployments[0]?.cid || ''

    return {
      name: domain.arnsName,
      transactionId: domain.arnsTransactionId,
      contentId,
    }
  } catch (error) {
    console.error('Failed to get ArNS record:', error)
    return null
  }
}

/**
 * Automatically update ArNS on new deployment
 */
export async function autoUpdateArnsOnDeploy(
  siteId: string,
  newCid: string,
  config: ArnsConfig
): Promise<void> {
  // Find all ArNS domains for this site
  const domains = await prisma.domain.findMany({
    where: {
      siteId,
      domainType: 'ARNS',
    },
  })

  // Update each ArNS record
  for (const domain of domains) {
    if (domain.arnsName) {
      try {
        await updateArnsRecord(domain.id, newCid, config)
        console.log(`Updated ArNS record ${domain.arnsName} to CID ${newCid}`)
      } catch (error) {
        console.error(`Failed to update ArNS record ${domain.arnsName}:`, error)
      }
    }
  }
}
