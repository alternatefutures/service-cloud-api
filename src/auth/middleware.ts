import type { PrismaClient } from '@prisma/client';
import type { YogaInitialContext } from 'graphql-yoga';

export interface AuthContext {
  userId?: string;
  projectId?: string;
}

export async function getAuthContext(
  request: Request,
  prisma: PrismaClient
): Promise<AuthContext> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return {};
  }

  // Support both "Bearer TOKEN" and just "TOKEN"
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  try {
    // Look up personal access token
    const pat = await prisma.personalAccessToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!pat) {
      return {};
    }

    // Update last used timestamp
    await prisma.personalAccessToken.update({
      where: { id: pat.id },
      data: { lastUsedAt: new Date() },
    });

    // Get project ID from X-Project-Id header (optional)
    const projectId = request.headers.get('x-project-id') || undefined;

    return {
      userId: pat.userId,
      projectId,
    };
  } catch (error) {
    console.error('Auth error:', error);
    return {};
  }
}
