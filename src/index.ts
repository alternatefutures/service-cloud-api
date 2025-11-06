import 'dotenv/config';
import { createYoga } from 'graphql-yoga';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from './schema/typeDefs.js';
import { resolvers } from './resolvers/index.js';
import { getAuthContext } from './auth/middleware.js';
import { ChatServer } from './services/chat/chatServer.js';
import { handleStripeWebhook } from './services/billing/webhookHandler.js';
import {
  StorageSnapshotScheduler,
  InvoiceScheduler,
  UsageAggregator,
} from './services/billing/index.js';
import { startSslRenewalJob } from './jobs/sslRenewal.js';

const prisma = new PrismaClient();

// Initialize billing schedulers
const storageSnapshotScheduler = new StorageSnapshotScheduler(prisma);
const invoiceScheduler = new InvoiceScheduler(prisma);
const usageAggregator = new UsageAggregator(prisma);
const jwtSecret = process.env.JWT_SECRET || 'development-secret-change-in-production';

const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

const yoga = createYoga({
  schema,
  context: async ({ request }) => {
    const authContext = await getAuthContext(request, prisma);
    return {
      prisma,
      ...authContext,
    };
  },
  cors: {
    origin: process.env.APP_URL || '*',
    credentials: true,
  },
  graphqlEndpoint: '/graphql',
  landingPage: true,
});

// Custom request handler to intercept webhook requests
async function requestHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Handle Stripe webhooks
  if (url.pathname === '/webhooks/stripe') {
    await handleStripeWebhook(req, res, prisma);
    return;
  }

  // Pass all other requests to Yoga
  return yoga(req, res);
}

// Create HTTP server with custom request handler
const server = createServer(requestHandler);

// Initialize Chat WebSocket Server
const chatServer = new ChatServer(prisma, jwtSecret);

// Handle WebSocket upgrade for /ws path
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '/', `http://${request.headers.host}`);

  if (pathname === '/ws') {
    chatServer.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

const port = process.env.PORT || 4000;

server.listen(port, () => {
  console.log(`🚀 GraphQL server running at http://localhost:${port}/graphql`);
  console.log(`💬 WebSocket chat server running at ws://localhost:${port}/ws`);

  // Start billing schedulers
  storageSnapshotScheduler.start();
  invoiceScheduler.start();
  usageAggregator.start();
  console.log(`📊 Billing schedulers started`);
  console.log(`⚡ Usage aggregator running (1-minute intervals)`);

  // Start SSL renewal job
  startSslRenewalJob();
  console.log(`🔒 SSL renewal job started (runs daily at 2 AM)`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await chatServer.shutdown();
    await usageAggregator.shutdown();
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('\nSIGINT signal received: closing HTTP server');
  server.close(async () => {
    await chatServer.shutdown();
    await usageAggregator.shutdown();
    await prisma.$disconnect();
    process.exit(0);
  });
});
