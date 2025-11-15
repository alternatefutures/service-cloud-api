/**
 * DNS Management Types
 * For OpenProvider API integration and Akash deployment automation
 */

export interface DNSRecord {
  id?: string
  name: string
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS'
  value: string
  ttl: number
  priority?: number
}

export interface OpenProviderConfig {
  username: string
  password: string
  apiUrl?: string
}

export interface AkashDeployment {
  dseq: string
  provider: string
  services: AkashService[]
}

export interface AkashService {
  name: string
  externalIP?: string
  port?: number
  subdomain: string
  dnsRecord?: DNSRecord
}

export interface DNSUpdateResult {
  success: boolean
  recordId?: string
  error?: string
  propagationTime?: number
}

export interface DNSHealthCheck {
  subdomain: string
  expectedIP: string
  currentIP?: string
  healthy: boolean
  checkedAt: Date
}
