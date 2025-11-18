import acme from 'acme-client'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface SslCertificate {
  certificateId: string
  certificate: string
  privateKey: string
  issuedAt: Date
  expiresAt: Date
}

export interface AcmeConfig {
  email: string
  accountKey?: Buffer
  directoryUrl?: string
}

/**
 * Initialize ACME client for Let's Encrypt
 */
export async function createAcmeClient(
  config: AcmeConfig
): Promise<acme.Client> {
  const directoryUrl =
    config.directoryUrl || acme.directory.letsencrypt.production

  // Create or load account key
  const accountKey = config.accountKey || (await acme.crypto.createPrivateKey())

  // Initialize client
  const client = new acme.Client({
    directoryUrl,
    accountKey,
  })

  return client
}

/**
 * Request SSL certificate from Let's Encrypt
 */
export async function requestSslCertificate(
  domain: string,
  email: string
): Promise<SslCertificate> {
  try {
    // Create ACME client
    const client = await createAcmeClient({ email })

    // Create private key for certificate
    const [key, csr] = await acme.crypto.createCsr({
      commonName: domain,
    })

    // Request certificate
    const cert = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        // HTTP-01 challenge handler
        // Store challenge for verification endpoint
        if (challenge.type === 'http-01') {
          await storeHttpChallenge(domain, challenge.token, keyAuthorization)
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        // Cleanup challenge after verification
        if (challenge.type === 'http-01') {
          await removeHttpChallenge(domain, challenge.token)
        }
      },
    })

    // Parse certificate expiration date
    const certInfo = await acme.crypto.readCertificateInfo(cert)
    const expiresAt = certInfo.notAfter
    const issuedAt = certInfo.notBefore

    return {
      certificateId: (certInfo as any).serial || 'unknown',
      certificate: cert.toString(),
      privateKey: key.toString(),
      issuedAt,
      expiresAt,
    }
  } catch (error) {
    throw new Error(
      `SSL certificate request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Request wildcard SSL certificate
 */
export async function requestWildcardCertificate(
  domain: string,
  email: string
): Promise<SslCertificate> {
  try {
    const client = await createAcmeClient({ email })

    const [key, csr] = await acme.crypto.createCsr({
      commonName: `*.${domain}`,
      altNames: [domain, `*.${domain}`],
    })

    const cert = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        // DNS-01 challenge required for wildcard
        if (challenge.type === 'dns-01') {
          const dnsRecord = await (acme.crypto as any).getDnsChallenge(
            keyAuthorization
          )
          await storeDnsChallenge(domain, challenge.token, dnsRecord)
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        if (challenge.type === 'dns-01') {
          await removeDnsChallenge(domain, challenge.token)
        }
      },
    })

    const certInfo = await acme.crypto.readCertificateInfo(cert)

    return {
      certificateId: (certInfo as any).serial || 'unknown',
      certificate: cert.toString(),
      privateKey: key.toString(),
      issuedAt: certInfo.notBefore,
      expiresAt: certInfo.notAfter,
    }
  } catch (error) {
    throw new Error(
      `Wildcard certificate request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Renew SSL certificate
 */
export async function renewSslCertificate(
  domainId: string,
  email: string
): Promise<SslCertificate> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
  })

  if (!domain) {
    throw new Error('Domain not found')
  }

  // Request new certificate
  const newCert = await requestSslCertificate(domain.hostname, email)

  // Update domain with new certificate
  await prisma.domain.update({
    where: { id: domainId },
    data: {
      sslCertificateId: newCert.certificateId,
      sslIssuedAt: newCert.issuedAt,
      sslExpiresAt: newCert.expiresAt,
      sslStatus: 'ACTIVE',
    },
  })

  return newCert
}

/**
 * Check if certificate needs renewal (30 days before expiration)
 */
export function shouldRenewCertificate(expiresAt: Date): boolean {
  const now = new Date()
  const daysUntilExpiry =
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  return daysUntilExpiry <= 30
}

/**
 * Auto-renew certificates that are expiring soon
 */
export async function autoRenewCertificates(email: string): Promise<void> {
  const domains = await prisma.domain.findMany({
    where: {
      sslAutoRenew: true,
      sslStatus: 'ACTIVE',
    },
  })

  for (const domain of domains) {
    if (domain.sslExpiresAt && shouldRenewCertificate(domain.sslExpiresAt)) {
      try {
        console.log(`Auto-renewing certificate for ${domain.hostname}`)
        await renewSslCertificate(domain.id, email)
        console.log(`Successfully renewed certificate for ${domain.hostname}`)
      } catch (error) {
        console.error(
          `Failed to renew certificate for ${domain.hostname}:`,
          error
        )
        await prisma.domain.update({
          where: { id: domain.id },
          data: { sslStatus: 'FAILED' },
        })
      }
    }
  }
}

// Challenge storage helpers
// These should be implemented to store challenges in database or cache

async function storeHttpChallenge(
  domain: string,
  token: string,
  keyAuth: string
): Promise<void> {
  // Store in Redis or database for /.well-known/acme-challenge/{token} endpoint
  console.log(`Store HTTP challenge for ${domain}: ${token} = ${keyAuth}`)
  // TODO: Implement challenge storage
}

async function removeHttpChallenge(
  domain: string,
  token: string
): Promise<void> {
  console.log(`Remove HTTP challenge for ${domain}: ${token}`)
  // TODO: Implement challenge removal
}

async function storeDnsChallenge(
  domain: string,
  token: string,
  dnsRecord: string
): Promise<void> {
  console.log(`Store DNS challenge for ${domain}: ${token} = ${dnsRecord}`)
  // TODO: Implement DNS challenge storage (requires DNS management API)
}

async function removeDnsChallenge(
  domain: string,
  token: string
): Promise<void> {
  console.log(`Remove DNS challenge for ${domain}: ${token}`)
  // TODO: Implement DNS challenge removal
}
