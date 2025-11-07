/**
 * Expired Token Cleanup Job
 *
 * Periodically removes expired Personal Access Tokens from the database.
 * Optimized with the expiresAt index for efficient queries.
 *
 * Schedule: Daily at 2:00 AM UTC
 * Cron: 0 2 * * *
 */

import { PrismaClient } from '@prisma/client';
import { TokenService } from '../services/auth/tokenService.js';
import { tokenServiceLogger } from '../services/auth/logger.js';

const prisma = new PrismaClient();
const tokenService = new TokenService(prisma);

export async function cleanupExpiredTokens(): Promise<{
  success: boolean;
  deletedCount: number;
  error?: string;
}> {
  try {
    tokenServiceLogger.info('Starting expired token cleanup job');

    const deletedCount = await tokenService.cleanupExpiredTokens();

    tokenServiceLogger.info('Expired token cleanup completed', {
      operation: 'cleanup-job',
      deletedCount,
      success: true,
    });

    return {
      success: true,
      deletedCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    tokenServiceLogger.error('Expired token cleanup job failed', {
      operation: 'cleanup-job',
      success: false,
    }, error as Error);

    return {
      success: false,
      deletedCount: 0,
      error: errorMessage,
    };
  } finally {
    await prisma.$disconnect();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupExpiredTokens()
    .then((result) => {
      console.log('Cleanup result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Cleanup failed:', error);
      process.exit(1);
    });
}
