/**
 * DNS Admin & Domain Registration Resolvers
 * GraphQL resolvers for DNS record management and domain purchasing via OpenProvider
 *
 * Access is scoped to org members: the requested domain must belong to an org
 * the caller is a member of. For user-facing domain lifecycle, see domain.ts
 */
import { GraphQLError } from 'graphql'
import { Context } from './types.js'
import { OpenProviderClient } from '../services/dns/openProviderClient.js'
import { getSecret } from '../config/infisical.js'
import type { DNSRecord } from '../services/dns/types.js'

let openProviderClient: OpenProviderClient | null = null

async function getOpenProviderClient(): Promise<OpenProviderClient> {
  if (!openProviderClient) {
    const username = await getSecret('OPENPROVIDER_USERNAME')
    const password = await getSecret('OPENPROVIDER_PASSWORD')

    if (!username || !password) {
      throw new GraphQLError('OpenProvider credentials not configured')
    }

    let apiUrl: string | undefined
    try {
      apiUrl = getSecret('OPENPROVIDER_API_URL')
    } catch {
      // Optional — defaults to production https://api.openprovider.eu
    }

    openProviderClient = new OpenProviderClient({
      username,
      password,
      apiUrl,
    })
  }
  return openProviderClient
}

/**
 * Verify the caller has access to the domain via org membership.
 * Checks if the domain is owned by an org the user belongs to, either directly
 * (organizationId on domain) or indirectly (via site -> project -> organization).
 */
async function requireDomainAccess(
  domainHostname: string,
  userId: string,
  organizationId: string | undefined,
  prisma: any
): Promise<void> {
  const domain = await prisma.domain.findUnique({
    where: { hostname: domainHostname },
    select: {
      organizationId: true,
      site: { select: { project: { select: { organizationId: true, userId: true } } } },
    },
  })

  if (domain) {
    const domainOrgId = domain.organizationId || domain.site?.project?.organizationId
    if (domainOrgId) {
      if (organizationId === domainOrgId) return
      const membership = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: domainOrgId, userId } },
      })
      if (membership) return
    }
    if (domain.site?.project?.userId === userId) return
  }

  // Domain not in DB — allow if user has an active org context
  // (they're managing a new zone not yet tracked in the DB)
  if (!domain && organizationId) {
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    if (membership) return
  }

  throw new GraphQLError('Not authorized to manage DNS for this domain')
}

export const dnsAdminQueries = {
  /**
   * List all DNS records for a domain
   */
  dnsRecords: async (
    _: unknown,
    { domain }: { domain: string },
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireDomainAccess(domain, userId, organizationId, prisma)

    const client = await getOpenProviderClient()
    const records = await client.listDNSRecords(domain)

    return records.map(record => ({
      id: record.id,
      name: record.name,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      priority: record.priority,
    }))
  },

  /**
   * Get a specific DNS record by name and type
   */
  dnsRecord: async (
    _: unknown,
    {
      domain,
      name,
      type,
    }: { domain: string; name: string; type: DNSRecord['type'] },
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireDomainAccess(domain, userId, organizationId, prisma)

    const client = await getOpenProviderClient()
    const record = await client.findDNSRecord(domain, name, type)

    if (!record) return null

    return {
      id: record.id,
      name: record.name,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      priority: record.priority,
    }
  },
}

export const dnsAdminMutations = {
  /**
   * Add a new DNS record
   */
  addDnsRecord: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        domain: string
        name: string
        type: DNSRecord['type']
        value: string
        ttl?: number
        priority?: number
      }
    },
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireDomainAccess(input.domain, userId, organizationId, prisma)

    const client = await getOpenProviderClient()

    const result = await client.createDNSRecord(input.domain, {
      name: input.name,
      type: input.type,
      value: input.value,
      ttl: input.ttl ?? 300,
      priority: input.priority,
    })

    return {
      success: result.success,
      recordId: result.recordId,
      error: result.error,
    }
  },

  /**
   * Update an existing DNS record
   */
  updateDnsRecord: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        domain: string
        recordId: string
        value?: string
        ttl?: number
        priority?: number
      }
    },
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireDomainAccess(input.domain, userId, organizationId, prisma)

    const client = await getOpenProviderClient()

    const updates: Partial<DNSRecord> = {}
    if (input.value !== undefined) updates.value = input.value
    if (input.ttl !== undefined) updates.ttl = input.ttl
    if (input.priority !== undefined) updates.priority = input.priority

    const result = await client.updateDNSRecord(
      input.domain,
      input.recordId,
      updates
    )

    return {
      success: result.success,
      recordId: result.recordId,
      error: result.error,
    }
  },

  /**
   * Delete a DNS record
   */
  deleteDnsRecord: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        domain: string
        recordId: string
      }
    },
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireDomainAccess(input.domain, userId, organizationId, prisma)

    const client = await getOpenProviderClient()

    const result = await client.deleteDNSRecord(input.domain, input.recordId)

    return {
      success: result.success,
      recordId: result.recordId,
      error: result.error,
    }
  },
}

// ── Domain Registration / Purchase ───────────────────────────────────

async function requireOrgMembership(
  orgId: string,
  userId: string,
  prisma: any
): Promise<void> {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  })
  if (!membership) {
    throw new GraphQLError('Not a member of this organization')
  }
}

export const domainRegistrationQueries = {
  checkDomainAvailability: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        domains: Array<{ name: string; extension: string }>
        withPrice?: boolean
      }
    },
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const client = await getOpenProviderClient()
    return await client.checkDomainAvailability(
      input.domains,
      input.withPrice ?? true
    )
  },

  domainPricing: async (
    _: unknown,
    {
      name,
      extension,
      operation,
      period,
    }: {
      name: string
      extension: string
      operation?: string
      period?: number
    },
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const client = await getOpenProviderClient()
    return await client.getDomainPrice(
      name,
      extension,
      (operation as 'create' | 'renew' | 'transfer') ?? 'create',
      period ?? 1
    )
  },

  registeredDomains: async (
    _: unknown,
    {
      limit,
      offset,
      status,
    }: {
      limit?: number
      offset?: number
      status?: string
    },
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const client = await getOpenProviderClient()
    return await client.listRegisteredDomains({ limit, offset, status })
  },
}

export const domainRegistrationMutations = {
  purchaseDomain: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        name: string
        extension: string
        orgId: string
        period?: number
        enableWhoisPrivacy?: boolean
        autorenew?: string
        acceptPremiumFee?: number
      }
    },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')
    await requireOrgMembership(input.orgId, userId, prisma)

    const ownerHandle = await getSecret('OPENPROVIDER_OWNER_HANDLE')
    if (!ownerHandle) {
      throw new GraphQLError(
        'Domain registration contact handle not configured'
      )
    }

    const client = await getOpenProviderClient()

    const hostname = `${input.name}.${input.extension}`

    const existing = await prisma.domain.findUnique({
      where: { hostname },
    })
    if (existing) {
      throw new GraphQLError('Domain hostname already registered in our system')
    }

    const result = await client.registerDomain({
      name: input.name,
      extension: input.extension,
      period: input.period ?? 1,
      ownerHandle,
      autorenew: (input.autorenew as 'on' | 'off' | 'default') ?? 'on',
      enableWhoisPrivacy: input.enableWhoisPrivacy ?? true,
      acceptPremiumFee: input.acceptPremiumFee,
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        domain: null,
      }
    }

    const domain = await prisma.domain.create({
      data: {
        hostname,
        organizationId: input.orgId,
        domainType: 'WEB2',
        verified: true,
        txtVerificationStatus: 'VERIFIED',
        sslStatus: 'NONE',
      },
    })

    // Create DNS zone so records can be managed immediately
    try {
      await client.createDNSZone(hostname)
    } catch {
      // Zone may already exist or creation can be retried
    }

    return {
      success: true,
      domainId: result.domainId,
      status: result.status,
      domain,
    }
  },
}
