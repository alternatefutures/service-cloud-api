import {
  PrismaClient,
  DomainType,
  VerificationStatus,
  SslStatus,
} from '@prisma/client'
import {
  generateVerificationToken,
  verifyTxtRecord,
  verifyCnameRecord,
  verifyARecord,
  getPlatformCnameTarget,
  getPlatformIpAddress,
} from './dnsVerification.js'
import { requestSslCertificate } from './sslCertificate.js'

const defaultPrisma = new PrismaClient()

export interface CreateDomainInput {
  hostname: string
  siteId: string
  domainType?: DomainType
  verificationMethod?: 'TXT' | 'CNAME' | 'A'
}

export interface DomainVerificationInstructions {
  method: 'TXT' | 'CNAME' | 'A'
  recordType: string
  hostname: string
  value: string
  instructions: string
}

/**
 * Create a new custom domain for a site
 */
export async function createCustomDomain(
  input: CreateDomainInput,
  prisma: PrismaClient = defaultPrisma
) {
  const {
    hostname,
    siteId,
    domainType = 'WEB2',
    verificationMethod = 'TXT',
  } = input

  // Check if domain already exists
  const existing = await prisma.domain.findUnique({
    where: { hostname },
  })

  if (existing) {
    throw new Error(`Domain ${hostname} is already registered`)
  }

  // Generate verification token
  const verificationToken = generateVerificationToken(hostname)

  // Determine expected values based on verification method
  const expectedCname =
    verificationMethod === 'CNAME' ? getPlatformCnameTarget() : null
  const expectedARecord =
    verificationMethod === 'A' ? getPlatformIpAddress() : null

  // Create domain
  const domain = await prisma.domain.create({
    data: {
      hostname,
      siteId,
      domainType,
      txtVerificationToken: verificationToken,
      txtVerificationStatus: 'PENDING',
      expectedCname,
      expectedARecord,
      verified: false,
      sslStatus: 'NONE',
    },
  })

  return domain
}

/**
 * Get verification instructions for a domain
 */
export async function getVerificationInstructions(
  domainId: string,
  prisma: PrismaClient = defaultPrisma
): Promise<DomainVerificationInstructions> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  // Determine which verification method to use
  if (domain.txtVerificationToken) {
    return {
      method: 'TXT',
      recordType: 'TXT',
      hostname: domain.hostname,
      value: domain.txtVerificationToken,
      instructions: `Add a TXT record to your DNS with the value: ${domain.txtVerificationToken}`,
    }
  }

  if (domain.expectedCname) {
    return {
      method: 'CNAME',
      recordType: 'CNAME',
      hostname: domain.hostname,
      value: domain.expectedCname,
      instructions: `Add a CNAME record pointing ${domain.hostname} to ${domain.expectedCname}`,
    }
  }

  if (domain.expectedARecord) {
    return {
      method: 'A',
      recordType: 'A',
      hostname: domain.hostname,
      value: domain.expectedARecord,
      instructions: `Add an A record pointing ${domain.hostname} to ${domain.expectedARecord}`,
    }
  }

  throw new Error('No verification method configured for this domain')
}

/**
 * Verify domain ownership via DNS
 */
export async function verifyDomainOwnership(
  domainId: string,
  prisma: PrismaClient = defaultPrisma
): Promise<boolean> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  let verified = false

  // Try TXT verification
  if (domain.txtVerificationToken) {
    const result = await verifyTxtRecord(
      domain.hostname,
      domain.txtVerificationToken
    )
    verified = result.verified

    await prisma.domain.update({
      where: { id: domainId },
      data: {
        txtVerificationStatus: verified ? 'VERIFIED' : 'FAILED',
        dnsCheckAttempts: { increment: 1 },
        lastDnsCheck: new Date(),
      },
    })
  }

  // Try CNAME verification
  if (!verified && domain.expectedCname) {
    const result = await verifyCnameRecord(
      domain.hostname,
      domain.expectedCname
    )
    verified = result.verified

    await prisma.domain.update({
      where: { id: domainId },
      data: {
        dnsCheckAttempts: { increment: 1 },
        lastDnsCheck: new Date(),
      },
    })
  }

  // Try A record verification
  if (!verified && domain.expectedARecord) {
    const result = await verifyARecord(domain.hostname, domain.expectedARecord)
    verified = result.verified

    await prisma.domain.update({
      where: { id: domainId },
      data: {
        dnsCheckAttempts: { increment: 1 },
        lastDnsCheck: new Date(),
      },
    })
  }

  // Update domain verification status
  if (verified) {
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        verified: true,
        dnsVerifiedAt: new Date(),
        txtVerificationStatus: 'VERIFIED',
      },
    })
  }

  return verified
}

/**
 * Provision SSL certificate for verified domain
 */
export async function provisionSslCertificate(
  domainId: string,
  email: string,
  prisma: PrismaClient = defaultPrisma
): Promise<void> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  if (!domain.verified) {
    throw new Error(
      'Domain must be verified before provisioning SSL certificate'
    )
  }

  // Update status to pending
  await prisma.domain.update({
    where: { id: domainId },
    data: { sslStatus: 'PENDING' },
  })

  try {
    // Request SSL certificate from Let's Encrypt
    const cert = await requestSslCertificate(domain.hostname, email)

    // Update domain with certificate info
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslStatus: 'ACTIVE',
        sslCertificateId: cert.certificateId,
        sslIssuedAt: cert.issuedAt,
        sslExpiresAt: cert.expiresAt,
      },
    })

    // TODO: Store certificate and private key securely
    // This should be stored in a secure secrets manager (Vault, AWS Secrets Manager, etc.)
  } catch (error) {
    await prisma.domain.update({
      where: { id: domainId },
      data: { sslStatus: 'FAILED' },
    })
    throw error
  }
}

/**
 * Remove a custom domain
 */
export async function removeCustomDomain(
  domainId: string,
  prisma: PrismaClient = defaultPrisma
): Promise<void> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { primarySite: true },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  // Check if this is a primary domain
  if (domain.primarySite.length > 0) {
    throw new Error(
      'Cannot remove primary domain. Set a different primary domain first.'
    )
  }

  // TODO: Revoke SSL certificate if exists

  // Delete domain
  await prisma.domain.delete({
    where: { id: domainId },
  })
}

/**
 * Set domain as primary for site
 */
export async function setPrimaryDomain(
  siteId: string,
  domainId: string,
  prisma: PrismaClient = defaultPrisma
): Promise<void> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  if (domain.siteId !== siteId) {
    throw new Error('Domain does not belong to this site')
  }

  if (!domain.verified) {
    throw new Error('Only verified domains can be set as primary')
  }

  // Update site's primary domain
  await prisma.site.update({
    where: { id: siteId },
    data: { primaryDomainId: domainId },
  })
}

/**
 * List all domains for a site
 */
export async function listDomainsForSite(
  siteId: string,
  prisma: PrismaClient = defaultPrisma
) {
  return await prisma.domain.findMany({
    where: { siteId },
    orderBy: { createdAt: 'desc' },
  })
}
