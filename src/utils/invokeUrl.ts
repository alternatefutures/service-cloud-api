export function generateInvokeUrl(slug: string): string {
  const domain = process.env.FUNCTIONS_DOMAIN || 'af-functions.dev';
  return `https://${slug}.${domain}`;
}
