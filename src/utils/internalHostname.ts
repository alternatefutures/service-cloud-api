/**
 * Generate a deterministic internal hostname for a service.
 *
 * Pattern: {service-slug}.{project-slug}.internal
 *
 * This hostname is used for inter-service communication.  Today it resolves
 * to the service's external URL (subdomain proxy).  When running on a shared
 * Kubernetes cluster in the future, it can map directly to K8s service DNS.
 */
export function generateInternalHostname(
  serviceSlug: string,
  projectSlug: string,
): string {
  return `${serviceSlug}.${projectSlug}.internal`
}
