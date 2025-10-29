/**
 * Alternate Futures Function Runtime Server
 *
 * Handles function invocations with integrated routing support.
 * Demonstrates integration of RuntimeRouter for ALT-7.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { RuntimeRouter } from '../services/routing/runtimeRouter.js';
import type { ProxyRequest } from '../services/routing/requestProxy.js';

const prisma = new PrismaClient();

// Initialize RuntimeRouter
const router = new RuntimeRouter(prisma, {
  cacheTTL: 300000,      // 5 minutes
  proxyTimeout: 30000,   // 30 seconds
});

/**
 * Parse incoming HTTP request to ProxyRequest format
 */
function parseRequest(req: any): ProxyRequest {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Parse query parameters
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    method: req.method,
    path: url.pathname,
    headers: req.headers,
    query,
    body: undefined, // Will be populated if needed
  };
}

/**
 * Execute user's function code (placeholder)
 * In production, this would load and execute code from IPFS
 */
async function executeUserFunction(functionId: string, request: ProxyRequest): Promise<any> {
  // This is a placeholder - in production:
  // 1. Load function CID from database
  // 2. Fetch function code from IPFS
  // 3. Execute in sandboxed environment
  // 4. Return result

  return {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/json',
      'x-function-id': functionId,
      'x-execution-mode': 'direct',
    },
    body: {
      message: 'Function executed directly (no route matched)',
      functionId,
      path: request.path,
      method: request.method,
      note: 'This is a placeholder - actual function execution not yet implemented',
    },
  };
}

/**
 * Main request handler
 */
async function handleRequest(req: any, res: any) {
  try {
    // Extract function identifier from subdomain or path
    // Format: https://function-slug.af-functions.dev
    const host = req.headers.host || '';
    const subdomain = host.split('.')[0];

    // In production, look up function by slug
    // For now, use subdomain as function identifier
    const functionSlug = subdomain;

    console.log(`📨 Request: ${req.method} ${req.url} [Function: ${functionSlug}]`);

    // Parse request
    const proxyRequest = parseRequest(req);

    // If request has body, read it
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString();
      if (body) {
        try {
          proxyRequest.body = JSON.parse(body);
        } catch {
          proxyRequest.body = body;
        }
      }
    }

    // Look up function by slug
    const afFunction = await prisma.aFFunction.findUnique({
      where: { slug: functionSlug },
      select: { id: true, name: true, slug: true, routes: true },
    });

    if (!afFunction) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Function not found',
        slug: functionSlug,
      }));
      return;
    }

    console.log(`🔍 Function found: ${afFunction.name} (${afFunction.id})`);

    // Check routes count
    const routesCount = afFunction.routes ? Object.keys(afFunction.routes as any).length : 0;
    console.log(`📋 Routes configured: ${routesCount}`);

    // Try routing first
    const routedResponse = await router.handleRequest(afFunction.id, proxyRequest);

    if (routedResponse) {
      // Route matched - return proxied response
      console.log(`✅ Route matched - proxied to target`);

      res.writeHead(routedResponse.status, routedResponse.headers);

      if (typeof routedResponse.body === 'string') {
        res.end(routedResponse.body);
      } else {
        res.end(JSON.stringify(routedResponse.body));
      }
      return;
    }

    // No route matched - execute user's function code
    console.log(`⚙️  No route matched - executing function code`);

    const functionResponse = await executeUserFunction(afFunction.id, proxyRequest);

    res.writeHead(functionResponse.status, functionResponse.headers);

    if (typeof functionResponse.body === 'string') {
      res.end(functionResponse.body);
    } else {
      res.end(JSON.stringify(functionResponse.body));
    }

  } catch (error) {
    console.error('❌ Error handling request:', error);

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

// Create HTTP server
const server = createServer(handleRequest);

const PORT = process.env.RUNTIME_PORT || 3000;

server.listen(PORT, () => {
  console.log('🚀 Alternate Futures Function Runtime');
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   RouterCache TTL: 5 minutes`);
  console.log(`   Proxy Timeout: 30 seconds`);
  console.log('');
  console.log('📝 Usage:');
  console.log(`   curl http://function-slug.localhost:${PORT}/api/test`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('\nSIGINT signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
