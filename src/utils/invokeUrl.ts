export function generateInvokeUrl(slug: string): string {
  const baseDomain = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'
  return `https://${slug}-app.${baseDomain}`
}

export function generateAgentUrl(slug: string): string {
  const baseDomain = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'
  return `https://${slug}-agent.${baseDomain}`
}
