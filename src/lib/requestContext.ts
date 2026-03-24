import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

interface RequestStore {
  requestId: string
}

export const requestContext = new AsyncLocalStorage<RequestStore>()

export function getRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id']
  if (typeof incoming === 'string' && incoming.length > 0) return incoming
  return randomUUID()
}
