/**
 * Stripe Webhook Handler
 *
 * Handles incoming Stripe webhook events
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import Stripe from 'stripe'
import type { PrismaClient } from '@prisma/client'
import { StripeService } from './stripeService.js'
import { createLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'

const log = createLogger('webhook-handler')

// Get Stripe webhook secret from environment
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

/**
 * Handle Stripe webhook POST request
 */
export async function handleStripeWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
): Promise<void> {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  try {
    // Read the raw body
    const body = await getRawBody(req)

    // Get Stripe signature from headers
    const signature = req.headers['stripe-signature']

    if (!signature || typeof signature !== 'string') {
      log.error('Missing Stripe signature')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing signature' }))
      return
    }

    if (!webhookSecret) {
      log.error('STRIPE_WEBHOOK_SECRET not configured')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Webhook secret not configured' }))
      return
    }

    // Verify the webhook signature and construct the event
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2025-10-29.clover',
    })

    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    } catch (err) {
      log.error(err, 'Webhook signature verification failed')
      // Audit signature failures — repeated misses on this endpoint
      // would indicate a misconfigured webhook secret OR a forged
      // webhook attempt. Either way, on-call wants to know.
      audit(prisma, {
        category: 'billing',
        action: 'stripe.webhook.signature_invalid',
        status: 'error',
        errorMessage: (err as { message?: string })?.message ?? String(err),
      })
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid signature' }))
      return
    }

    log.info({ eventType: event.type }, 'Received Stripe webhook')

    // Handle the event with StripeService
    const startedAt = Date.now()
    try {
      const stripeService = new StripeService(prisma)
      await stripeService.handleWebhookEvent(event)

      audit(prisma, {
        category: 'billing',
        action: `stripe.webhook.${event.type}`,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        payload: { eventId: event.id, livemode: event.livemode },
      })

      // Return a 200 response to acknowledge receipt
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ received: true }))
    } catch (err) {
      log.error(err, 'Error processing webhook')
      audit(prisma, {
        category: 'billing',
        action: `stripe.webhook.${event.type}`,
        status: 'error',
        durationMs: Date.now() - startedAt,
        errorMessage: (err as { message?: string })?.message ?? String(err),
        payload: { eventId: event.id, livemode: event.livemode },
      })
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Processing failed' }))
    }
  } catch (err) {
    log.error(err, 'Webhook handler error')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}

/**
 * Read raw body from incoming request
 */
function getRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })

    req.on('error', err => {
      reject(err)
    })
  })
}
