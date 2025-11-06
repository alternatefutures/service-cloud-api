import { Resolver } from 'dns/promises';
import crypto from 'crypto';

const resolver = new Resolver();

export interface DnsVerificationResult {
  verified: boolean;
  record?: string;
  error?: string;
}

/**
 * Generate a unique verification token for TXT record verification
 */
export function generateVerificationToken(hostname: string): string {
  const randomBytes = crypto.randomBytes(16).toString('hex');
  return `af-site-verification=${randomBytes}`;
}

/**
 * Verify TXT record for domain ownership
 */
export async function verifyTxtRecord(
  hostname: string,
  expectedToken: string
): Promise<DnsVerificationResult> {
  try {
    const records = await resolver.resolveTxt(hostname);

    // Flatten TXT records (they come as arrays of arrays)
    const flatRecords = records.flat();

    // Check if any TXT record matches our verification token
    const found = flatRecords.some(record => record === expectedToken);

    if (found) {
      return {
        verified: true,
        record: expectedToken
      };
    }

    return {
      verified: false,
      error: 'Verification token not found in TXT records'
    };
  } catch (error) {
    return {
      verified: false,
      error: error instanceof Error ? error.message : 'DNS lookup failed'
    };
  }
}

/**
 * Verify CNAME record points to our platform
 */
export async function verifyCnameRecord(
  hostname: string,
  expectedTarget: string
): Promise<DnsVerificationResult> {
  try {
    const records = await resolver.resolveCname(hostname);

    // Check if CNAME points to expected target
    const found = records.some(record =>
      record.toLowerCase() === expectedTarget.toLowerCase() ||
      record.toLowerCase() === `${expectedTarget}.`.toLowerCase()
    );

    if (found) {
      return {
        verified: true,
        record: records[0]
      };
    }

    return {
      verified: false,
      error: `CNAME does not point to ${expectedTarget}`
    };
  } catch (error) {
    return {
      verified: false,
      error: error instanceof Error ? error.message : 'CNAME lookup failed'
    };
  }
}

/**
 * Verify A record points to our IP address
 */
export async function verifyARecord(
  hostname: string,
  expectedIp: string
): Promise<DnsVerificationResult> {
  try {
    const records = await resolver.resolve4(hostname);

    // Check if any A record matches our IP
    const found = records.some(record => record === expectedIp);

    if (found) {
      return {
        verified: true,
        record: records[0]
      };
    }

    return {
      verified: false,
      error: `A record does not point to ${expectedIp}`
    };
  } catch (error) {
    return {
      verified: false,
      error: error instanceof Error ? error.message : 'A record lookup failed'
    };
  }
}

/**
 * Check DNS propagation status
 * Returns true if DNS has propagated globally
 */
export async function checkDnsPropagation(
  hostname: string,
  recordType: 'TXT' | 'CNAME' | 'A',
  expectedValue: string
): Promise<boolean> {
  try {
    let result: DnsVerificationResult;

    switch (recordType) {
      case 'TXT':
        result = await verifyTxtRecord(hostname, expectedValue);
        break;
      case 'CNAME':
        result = await verifyCnameRecord(hostname, expectedValue);
        break;
      case 'A':
        result = await verifyARecord(hostname, expectedValue);
        break;
      default:
        return false;
    }

    return result.verified;
  } catch {
    return false;
  }
}

/**
 * Get platform CNAME target for domain configuration
 */
export function getPlatformCnameTarget(): string {
  return process.env.PLATFORM_CNAME_TARGET || 'cname.alternatefutures.ai';
}

/**
 * Get platform IP address for A record configuration
 */
export function getPlatformIpAddress(): string {
  return process.env.PLATFORM_IP_ADDRESS || '0.0.0.0';
}
