/**
 * Chat WebSocket Types
 *
 * Defines the message types and structures for real-time agent chat communication
 */

export enum WSMessageType {
  // Client -> Server
  AUTHENTICATE = 'authenticate',
  SEND_MESSAGE = 'send_message',
  TYPING = 'typing',
  READ_MESSAGES = 'read_messages',

  // Server -> Client
  MESSAGE_RECEIVED = 'message_received',
  AGENT_RESPONSE = 'agent_response',
  AGENT_TYPING = 'agent_typing',
  ERROR = 'error',
  AUTHENTICATED = 'authenticated',

  // Bidirectional
  PING = 'ping',
  PONG = 'pong',
}

export interface WSMessage {
  type: WSMessageType
  payload: any
  timestamp?: number
  messageId?: string
}

export interface WSAuthenticatePayload {
  token: string
  chatId?: string
}

export interface WSSendMessagePayload {
  chatId: string
  content: string
  attachments?: string[]
}

export interface WSMessageReceivedPayload {
  id: string
  chatId: string
  content: string
  role: 'USER' | 'AGENT' | 'SYSTEM'
  userId?: string
  agentId?: string
  createdAt: string
  metadata?: any
}

export interface WSErrorPayload {
  code: string
  message: string
  details?: any
}

export interface WSTypingPayload {
  chatId: string
  userId?: string
  isTyping: boolean
}

export interface ConnectionMetadata {
  userId: string
  chatId?: string
  connectedAt: Date
  lastActivity: Date
}
