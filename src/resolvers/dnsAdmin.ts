/**
 * DNS Admin Resolvers
 * GraphQL resolvers for DNS record management via OpenProvider
 *
 * These endpoints are admin-only for managing DNS records directly.
 * For user-facing domain management, see domain.ts
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

    openProviderClient = new OpenProviderClient({
      username,
      password,
    })
  }
  return openProviderClient
}

export const dnsAdminQueries = {
  /**
   * List all DNS records for a domain
   */
  dnsRecords: async (
    _: unknown,
    { domain }: { domain: string },
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    // TODO: Add admin role check when RBAC is implemented
    // For now, any authenticated user can manage DNS

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
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

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
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

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
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

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
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const client = await getOpenProviderClient()

    const result = await client.deleteDNSRecord(input.domain, input.recordId)

    return {
      success: result.success,
      recordId: result.recordId,
      error: result.error,
    }
  },
}
