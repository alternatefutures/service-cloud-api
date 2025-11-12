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
    // Validate token via auth service
    const validationResult = await validateTokenViaAuthService(token);

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
