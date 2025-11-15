/**
 * DNS Management Service
 * OpenProvider integration for Akash deployment automation
 */

export { OpenProviderClient } from './openProviderClient.js'
export { DNSManager } from './dnsManager.js'
export { AkashDNSSync } from './akashDnsSync.js'
export type {
  DNSRecord,
  OpenProviderConfig,
  AkashDeployment,
  AkashService,
  DNSUpdateResult,
  DNSHealthCheck,
} from './types.js'
