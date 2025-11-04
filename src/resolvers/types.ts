/**
 * Shared GraphQL Resolver Types
 */

import type { YogaInitialContext } from 'graphql-yoga';
import type { PrismaClient } from '@prisma/client';

export interface Context extends YogaInitialContext {
  prisma: PrismaClient;
  userId?: string;
  projectId?: string;
}
