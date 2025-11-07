import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface IpnsConfig {
  ipfsApiUrl?: string;
  ipfsApiKey?: string;
  privateKey?: string; // IPNS key
}

export interface IpnsRecord {
  ipnsHash: string; // The IPNS hash (public key hash)
  currentCid: string; // Current IPFS CID it points to
  lifetime?: string;
  ttl?: string;
}

/**
 * Create or update IPNS record for a domain
 * IPNS provides mutable pointers to IPFS content
 */
export async function publishIpnsRecord(
  domainId: string,
  cid: string,
  config: IpnsConfig
): Promise<IpnsRecord> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { site: true }
  });

  if (!domain) {
    throw new Error('Domain not found');
  }

  try {
    // Check if IPNS key already exists for this domain
    let ipnsKey = domain.ipnsHash;

    if (!ipnsKey) {
      // Generate new IPNS key
      // const ipfs = create({ url: config.ipfsApiUrl || 'http://localhost:5001' });
      // const key = await ipfs.key.gen(domain.hostname, { type: 'rsa', size: 2048 });
      // ipnsKey = key.id;

      // Placeholder for IPNS key generation
      ipnsKey = `k51qzi5uqu5d${domain.id.substring(0, 40)}`;
    }

    // Publish IPNS record
    // const ipfs = create({ url: config.ipfsApiUrl });
    // const result = await ipfs.name.publish(cid, {
    //   key: domain.hostname,
    //   lifetime: '24h',
    //   ttl: '1h'
    // });

    // Update domain with IPNS information
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        ipnsHash: ipnsKey,
        domainType: 'IPNS',
        verified: true,
        dnsVerifiedAt: new Date()
      }
    });

    // Update or create IPNS record in database
    await prisma.iPNSRecord.upsert({
      where: {
        siteId: domain.siteId
      } as any, // Type assertion for unique constraint compatibility
      create: {
        name: ipnsKey,
        hash: cid,
        siteId: domain.siteId
      },
      update: {
        hash: cid
      }
    });

    return {
      ipnsHash: ipnsKey,
      currentCid: cid,
      lifetime: '24h',
      ttl: '1h'
    };
  } catch (error) {
    throw new Error(`IPNS publish failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Resolve IPNS hash to current CID
 */
export async function resolveIpnsHash(ipnsHash: string, config: IpnsConfig): Promise<string | null> {
  try {
    // Resolve IPNS name to get current CID
    // const ipfs = create({ url: config.ipfsApiUrl });
    // const result = await ipfs.name.resolve(ipnsHash);
    // return result.path.replace('/ipfs/', '');

    // Placeholder: Check database
    const record = await prisma.iPNSRecord.findFirst({
      where: { name: ipnsHash }
    });

    return record?.hash || null;
  } catch (error) {
    console.error('IPNS resolution failed:', error);
    return null;
  }
}

/**
 * Update IPNS record to point to new content
 */
export async function updateIpnsRecord(
  domainId: string,
  newCid: string,
  config: IpnsConfig
): Promise<IpnsRecord> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId }
  });

  if (!domain) {
    throw new Error('Domain not found');
  }

  if (!domain.ipnsHash) {
    throw new Error('Domain does not have an IPNS record. Create one first.');
  }

  return await publishIpnsRecord(domainId, newCid, config);
}

/**
 * Get IPNS record details
 */
export async function getIpnsRecord(ipnsHash: string, config: IpnsConfig): Promise<IpnsRecord | null> {
  try {
    const record = await prisma.iPNSRecord.findFirst({
      where: { name: ipnsHash }
    });

    if (!record) {
      return null;
    }

    return {
      ipnsHash: record.name,
      currentCid: record.hash,
      lifetime: '24h',
      ttl: '1h'
    };
  } catch (error) {
    console.error('Failed to get IPNS record:', error);
    return null;
  }
}

/**
 * Automatically update IPNS on new deployment
 */
export async function autoUpdateIpnsOnDeploy(
  siteId: string,
  newCid: string,
  config: IpnsConfig
): Promise<void> {
  // Find all IPNS domains for this site
  const domains = await prisma.domain.findMany({
    where: {
      siteId,
      domainType: 'IPNS'
    }
  });

  // Update each IPNS record
  for (const domain of domains) {
    if (domain.ipnsHash) {
      try {
        await updateIpnsRecord(domain.id, newCid, config);
        console.log(`Updated IPNS record ${domain.ipnsHash} to CID ${newCid}`);
      } catch (error) {
        console.error(`Failed to update IPNS record ${domain.ipnsHash}:`, error);
      }
    }
  }
}

/**
 * Create IPNS key for domain
 */
export async function createIpnsKey(hostname: string, config: IpnsConfig): Promise<string> {
  try {
    // Generate IPNS key
    // const ipfs = create({ url: config.ipfsApiUrl });
    // const key = await ipfs.key.gen(hostname, { type: 'rsa', size: 2048 });
    // return key.id;

    // Placeholder
    return `k51qzi5uqu5d${hostname.replace(/[^a-z0-9]/gi, '').toLowerCase().substring(0, 40)}`;
  } catch (error) {
    throw new Error(`IPNS key generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * List all IPNS keys
 */
export async function listIpnsKeys(config: IpnsConfig): Promise<Array<{ name: string; id: string }>> {
  try {
    // const ipfs = create({ url: config.ipfsApiUrl });
    // const keys = await ipfs.key.list();
    // return keys.map(k => ({ name: k.name, id: k.id }));

    // Placeholder: Get from database
    const records = await prisma.iPNSRecord.findMany();
    return records.map(r => ({ name: r.name, id: r.name }));
  } catch (error) {
    console.error('Failed to list IPNS keys:', error);
    return [];
  }
}

/**
 * Delete IPNS key
 */
export async function deleteIpnsKey(keyName: string, config: IpnsConfig): Promise<boolean> {
  try {
    // const ipfs = create({ url: config.ipfsApiUrl });
    // await ipfs.key.rm(keyName);

    // Remove from database
    await prisma.iPNSRecord.deleteMany({
      where: { name: keyName }
    });

    return true;
  } catch (error) {
    console.error('Failed to delete IPNS key:', error);
    return false;
  }
}

/**
 * Get IPNS URL for a domain
 */
export function getIpnsUrl(ipnsHash: string, gatewayUrl: string = 'https://ipfs.io'): string {
  return `${gatewayUrl}/ipns/${ipnsHash}`;
}

/**
 * Validate IPNS hash format
 */
export function isValidIpnsHash(hash: string): boolean {
  // IPNS hashes typically start with 'k51' for ed25519 keys or 'k2k4r8' for RSA keys
  return hash.startsWith('k51') || hash.startsWith('k2k4r8') || hash.startsWith('Qm');
}
