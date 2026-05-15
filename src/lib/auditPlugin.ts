/**
 * GraphQL audit plugin.
 *
 * Emits one row in `AuditEvent` per executed Mutation operation. This
 * single plugin replaces ~100 hand-rolled `audit()` call sites we'd
 * otherwise need to scatter across the resolver layer to get the same
 * coverage. Queries and Subscriptions are intentionally NOT audited —
 * they're orders of magnitude more frequent and their state-change
 * surface is zero.
 *
 * What gets recorded:
 *   - traceId      — from request context (set by request middleware)
 *   - userId/orgId — from the resolver Context shape (auth middleware)
 *   - action       — `gql.mutation.<operationName>`
 *                    (anonymous mutations get `gql.mutation.anonymous`,
 *                     which is itself a flag worth alerting on)
 *   - status       — 'ok' if no errors, 'error' otherwise
 *   - durationMs   — wall-clock around `executeFn`
 *   - errorCode    — first error's `extensions.code` if present
 *   - errorMessage — first error's `message` (truncated by audit())
 *   - payload      — { hasVariables, variableKeys, errorCount }
 *                    Variables themselves are NEVER logged — they may
 *                    contain secrets (e.g. PAT names, deploy SDL).
 *
 * Failure mode: same as all audit() calls — fire-and-forget, never
 * throws, never blocks the GraphQL response.
 */

import type { Plugin } from 'graphql-yoga'
import type { PrismaClient } from '@prisma/client'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import { audit } from './audit.js'

interface ResolverContextShape {
  prisma?: unknown
  userId?: string | null
  organizationId?: string | null
  projectId?: string | null
}

function findMutationOp(document: DocumentNode | undefined): OperationDefinitionNode | null {
  if (!document) return null
  for (const def of document.definitions) {
    if (def.kind === 'OperationDefinition' && def.operation === 'mutation') {
      return def
    }
  }
  return null
}

export function useAuditPlugin(prisma: PrismaClient): Plugin {
  return {
    onExecute({ args }) {
      const op = findMutationOp(args.document)
      if (!op) {
        // Not a mutation — no audit row. Nothing else to do.
        return undefined
      }

      const operationName = args.operationName || op.name?.value || 'anonymous'
      const ctx = (args.contextValue ?? {}) as ResolverContextShape
      const variableValues = args.variableValues
      const variableKeys = variableValues
        ? Object.keys(variableValues as Record<string, unknown>)
        : []
      const startedAt = Date.now()

      return {
        onExecuteDone({ result }) {
          // Yoga calls onExecuteDone for both single-execution and
          // streaming results. For mutations we expect single
          // execution; if a stream sneaks through we record only the
          // initial result. Trying to consume the AsyncIterable here
          // would block the response.
          if ('initialResult' in (result as object)) {
            // Defer to the per-frame hook by returning undefined; we
            // intentionally do NOT instrument streaming mutations
            // (none exist in the schema today).
            return
          }

          const errors =
            result && typeof result === 'object' && 'errors' in result
              ? (result as { errors?: ReadonlyArray<{ message: string; extensions?: { code?: string } }> }).errors
              : undefined
          const errorCount = errors?.length ?? 0
          const status = errorCount > 0 ? 'error' : 'ok'
          const firstError = errors?.[0]
          const errorCode = firstError?.extensions?.code
          const errorMessage = firstError?.message

          audit(prisma, {
            category: 'system',
            action: `gql.mutation.${operationName}`,
            status,
            userId: ctx.userId ?? null,
            orgId: ctx.organizationId ?? null,
            projectId: ctx.projectId ?? null,
            durationMs: Date.now() - startedAt,
            errorCode: typeof errorCode === 'string' ? errorCode : undefined,
            errorMessage,
            payload: {
              source: 'graphql',
              hasVariables: variableKeys.length > 0,
              // Names only, never values — values may contain secrets.
              variableKeys,
              errorCount,
            },
          })
        },
      }
    },
  }
}
