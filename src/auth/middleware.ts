import type { PrismaClient } from '@prisma/client';
import type { YogaInitialContext } from 'graphql-yoga';

export interface AuthContext {
  userId?: string;
  projectId?: string;
}

/**
 * Validate token via auth service
 */
async function validateTokenViaAuthService(token: string): Promise<{ userId: string; tokenId: string } | null> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;

  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL not configured');
  }

  try {
    const response = await fetch(`${authServiceUrl}/tokens/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        return null; // Invalid token
      }
      throw new Error(`Auth service error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.valid) {
      return null;
    }

    return {
      userId: data.userId,
      tokenId: data.tokenId,
    };
  } catch (error) {
    console.error('Auth service validation error:', error);
    throw error;
  }
}

/**
 * Validate token locally (fallback during migration)
 */
async function validateTokenLocally(token: string, prisma: PrismaClient): Promise<{ userId: string; tokenId: string } | null> {
  try {
    const pat = await prisma.personalAccessToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!pat) {
      return null;
    }

    // Update last used timestamp
    await prisma.personalAccessToken.update({
      where: { id: pat.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      userId: pat.userId,
      tokenId: pat.id,
    };
  } catch (error) {
    console.error('Local token validation error:', error);
    throw error;
  }
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
    let validationResult: { userId: string; tokenId: string } | null = null;

    // Check if auth service is configured
    const useAuthService = !!process.env.AUTH_SERVICE_URL;

    if (useAuthService) {
      try {
        // Try auth service first
        validationResult = await validateTokenViaAuthService(token);
      } catch (error) {
        console.error('Auth service unavailable, falling back to local validation:', error);
        // Fall back to local validation if auth service is unavailable
        validationResult = await validateTokenLocally(token, prisma);
      }
    } else {
      // Use local validation if auth service is not configured
      validationResult = await validateTokenLocally(token, prisma);
    }

    if (!validationResult) {
      return {};
    }

    // Get project ID from X-Project-Id header (optional)
    const projectId = request.headers.get('x-project-id') || undefined;

    return {
      userId: validationResult.userId,
      projectId,
    };
  } catch (error) {
    console.error('Auth error:', error);
    return {};
  }
}
