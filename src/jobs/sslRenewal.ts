import cron from 'node-cron';
import { PrismaClient, SslStatus } from '@prisma/client';
import { shouldRenewCertificate, requestSslCertificate } from '../services/dns/sslCertificate';

const prisma = new PrismaClient();

/**
 * Check all domains for SSL certificate expiration and renew if needed
 * Runs daily at 2 AM
 */
export function startSslRenewalJob() {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[SSL Renewal] Starting SSL certificate renewal check...');

    try {
      await checkAndRenewCertificates();
      console.log('[SSL Renewal] SSL renewal check completed successfully');
    } catch (error) {
      console.error('[SSL Renewal] Error during SSL renewal check:', error);
    }
  });

  console.log('[SSL Renewal] SSL renewal cron job started (runs daily at 2 AM)');
}

/**
 * Check all domains and renew certificates that are expiring soon
 */
export async function checkAndRenewCertificates() {
  // Get all domains with active SSL certificates
  const domainsWithSsl = await prisma.domain.findMany({
    where: {
      sslStatus: SslStatus.ACTIVE,
      sslExpiresAt: {
        not: null,
      },
      sslAutoRenew: true,
      verified: true,
    },
    select: {
      id: true,
      hostname: true,
      sslExpiresAt: true,
      sslCertificateId: true,
      site: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  console.log(`[SSL Renewal] Found ${domainsWithSsl.length} domains with active SSL certificates`);

  const renewalResults = {
    total: domainsWithSsl.length,
    renewed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const domain of domainsWithSsl) {
    try {
      // Check if certificate needs renewal (30 days before expiry)
      if (!domain.sslExpiresAt || !shouldRenewCertificate(domain.sslExpiresAt)) {
        renewalResults.skipped++;
        continue;
      }

      console.log(`[SSL Renewal] Renewing certificate for ${domain.hostname} (expires: ${domain.sslExpiresAt})`);

      // Set status to pending
      await prisma.domain.update({
        where: { id: domain.id },
        data: { sslStatus: SslStatus.PENDING },
      });

      // Request new certificate
      // Use a system email from environment variable
      const email = process.env.SSL_RENEWAL_EMAIL || process.env.ADMIN_EMAIL || 'admin@alternatefutures.ai';
      const cert = await requestSslCertificate(domain.hostname, email);

      // Update domain with new certificate info
      await prisma.domain.update({
        where: { id: domain.id },
        data: {
          sslStatus: SslStatus.ACTIVE,
          sslCertificateId: cert.certificateId,
          sslIssuedAt: cert.issuedAt,
          sslExpiresAt: cert.expiresAt,
        },
      });

      renewalResults.renewed++;
      console.log(`[SSL Renewal] Successfully renewed certificate for ${domain.hostname}`);

      // TODO: Store new certificate and private key securely
      // TODO: Send notification email to site owner
    } catch (error: any) {
      renewalResults.failed++;
      console.error(`[SSL Renewal] Failed to renew certificate for ${domain.hostname}:`, error.message);

      // Update domain with failed status
      await prisma.domain.update({
        where: { id: domain.id },
        data: { sslStatus: SslStatus.FAILED },
      });

      // TODO: Send alert email to admin
    }
  }

  console.log('[SSL Renewal] Renewal summary:', renewalResults);

  return renewalResults;
}

/**
 * Get SSL certificate status and expiration info for all domains
 */
export async function getSslCertificateStatus() {
  const domains = await prisma.domain.findMany({
    where: {
      sslStatus: {
        in: [SslStatus.ACTIVE, SslStatus.EXPIRED],
      },
    },
    select: {
      id: true,
      hostname: true,
      sslStatus: true,
      sslExpiresAt: true,
      sslAutoRenew: true,
      verified: true,
      site: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      sslExpiresAt: 'asc',
    },
  });

  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return domains.map((domain) => {
    const expiresAt = domain.sslExpiresAt ? new Date(domain.sslExpiresAt) : null;
    const daysUntilExpiry = expiresAt
      ? Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    return {
      ...domain,
      daysUntilExpiry,
      needsRenewal: expiresAt ? expiresAt <= thirtyDaysFromNow : false,
      isExpired: expiresAt ? expiresAt <= now : false,
    };
  });
}

/**
 * Manually trigger SSL renewal for a specific domain
 */
export async function renewSslCertificate(domainId: string) {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    select: {
      id: true,
      hostname: true,
      verified: true,
      sslStatus: true,
      sslAutoRenew: true,
    },
  });

  if (!domain) {
    throw new Error('Domain not found');
  }

  if (!domain.verified) {
    throw new Error('Domain must be verified before renewing SSL certificate');
  }

  console.log(`[SSL Renewal] Manually renewing certificate for ${domain.hostname}`);

  // Set status to pending
  await prisma.domain.update({
    where: { id: domainId },
    data: { sslStatus: SslStatus.PENDING },
  });

  try {
    const email = process.env.SSL_RENEWAL_EMAIL || process.env.ADMIN_EMAIL || 'admin@alternatefutures.ai';
    const cert = await requestSslCertificate(domain.hostname, email);

    await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslStatus: SslStatus.ACTIVE,
        sslCertificateId: cert.certificateId,
        sslIssuedAt: cert.issuedAt,
        sslExpiresAt: cert.expiresAt,
      },
    });

    console.log(`[SSL Renewal] Successfully renewed certificate for ${domain.hostname}`);

    return cert;
  } catch (error) {
    await prisma.domain.update({
      where: { id: domainId },
      data: { sslStatus: SslStatus.FAILED },
    });

    throw error;
  }
}
