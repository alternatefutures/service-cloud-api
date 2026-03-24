import { GraphQLError } from 'graphql'
import type { Context } from '../resolvers/types.js'

/**
 * Checks whether the authenticated user/org context has access to a project.
 * Rules:
 *  - If the context has an organizationId, the project must belong to that org
 *    OR be owned directly by the user with no org attached.
 *  - Otherwise, the project must be directly owned by the user.
 */
export function assertProjectAccess(
  context: Context,
  project: { userId: string | null; organizationId: string | null },
  message = 'Not authorized to access this project'
): void {
  const authorized = context.organizationId
    ? project.organizationId === context.organizationId ||
      (project.userId === context.userId && project.organizationId === null)
    : project.userId === context.userId

  if (!authorized) {
    throw new GraphQLError(message, { extensions: { code: 'UNAUTHORIZED' } })
  }
}

/**
 * Require that the request has an authenticated userId.
 */
export function requireAuth(context: Context): string {
  if (!context.userId) {
    throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } })
  }
  return context.userId
}
