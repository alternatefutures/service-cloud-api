/**
 * DNS Management Service
 * OpenProvider integration for Akash deployment automation
 */

export { OpenProviderClient } from './openProviderClient.js'
export { DNSManager } from './dnsManager.js'
export type {
  DNSRecord,
  OpenProviderConfig,
  AkashDeployment,
  AkashService,
  DNSUpdateResult,
  DNSHealthCheck,
} from './types.js'

// Domain service functions
export * from './domainService.js'
export * from './arnsIntegration.js'
export * from './ensIntegration.js'
export * from './ipnsIntegration.js'
