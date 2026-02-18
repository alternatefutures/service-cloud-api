/**
 * Provider Registry
 *
 * Central registry for all compute providers. Providers register themselves
 * at startup; resolvers and templates look them up by name.
 *
 * Usage:
 *   import { registerProvider, getProvider, getAllProviders } from './registry.js'
 *
 *   // At startup (index.ts):
 *   registerProvider(createAkashProvider(prisma))
 *   registerProvider(createPhalaProvider(prisma))
 *
 *   // In resolvers / templates:
 *   const provider = getProvider('akash')
 *   await provider.deploy(serviceId, options)
 */

import type { DeploymentProvider } from './types.js'

const providers = new Map<string, DeploymentProvider>()

export function registerProvider(provider: DeploymentProvider): void {
  if (providers.has(provider.name)) {
    console.warn(`[ProviderRegistry] Overwriting existing provider: ${provider.name}`)
  }
  providers.set(provider.name, provider)
  console.log(`[ProviderRegistry] Registered provider: ${provider.name} (${provider.displayName})`)
}

export function getProvider(name: string): DeploymentProvider {
  const provider = providers.get(name)
  if (!provider) {
    const available = [...providers.keys()].join(', ') || '(none)'
    throw new Error(`Provider "${name}" not registered. Available: ${available}`)
  }
  return provider
}

export function tryGetProvider(name: string): DeploymentProvider | null {
  return providers.get(name) ?? null
}

export function getAllProviders(): DeploymentProvider[] {
  return [...providers.values()]
}

export function getAvailableProviders(): DeploymentProvider[] {
  return [...providers.values()].filter(p => p.isAvailable())
}

export function hasProvider(name: string): boolean {
  return providers.has(name)
}
