/**
 * WebSocket Chat Server
 *
 * Real-time agent chat server with WebSocket support
 * Handles authentication, message routing, and agent response generation
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { ConnectionManager } from './connectionManager.js'
import { MessageService } from './messageService.js'
import { AgentService } from './agentService.js'
import {
  WSMessageType,
  type WSMessage,
  type WSAuthenticatePayload,
  type WSSendMessagePayload,
  type WSErrorPayload,
} from './types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('chat-server')

export class ChatServer {
  private wss: WebSocketServer
  private connectionManager: ConnectionManager
  private messageService: MessageService
  private agentService: AgentService
  private prisma: PrismaClient
  private jwtSecret: string
  // Fixed by audit 2026-03: store interval ref so it can be cleared on shutdown
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(prisma: PrismaClient, jwtSecret: string) {
    this.prisma = prisma
    this.jwtSecret = jwtSecret
    this.connectionManager = new ConnectionManager()
    this.messageService = new MessageService(prisma)
    this.agentService = new AgentService(prisma)
    this.wss = new WebSocketServer({ noServer: true })

    this.setupWebSocketServer()
    this.startCleanupInterval()
  }

  /**
   * Set up WebSocket server event handlers
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      log.info('New WebSocket connection')

      ws.on('message', async (data: Buffer) => {
        try {
          const message: WSMessage = JSON.parse(data.toString())
          await this.handleMessage(ws, message)
        } catch (error) {
          log.error(error, 'Error handling message')
          this.sendError(ws, 'INVALID_MESSAGE', 'Invalid message format')
        }
      })

      ws.on('close', () => {
        this.connectionManager.removeConnection(ws)
        log.info('WebSocket connection closed')
      })

      ws.on('error', error => {
        log.error(error, 'WebSocket error')
      })

      ws.on('pong', () => {
        this.connectionManager.updateActivity(ws)
      })
    })
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(
    ws: WebSocket,
    message: WSMessage
  ): Promise<void> {
    this.connectionManager.updateActivity(ws)

    switch (message.type) {
      case WSMessageType.AUTHENTICATE:
        await this.handleAuthenticate(ws, message.payload)
        break

      case WSMessageType.SEND_MESSAGE:
        await this.handleSendMessage(ws, message.payload)
        break

      case WSMessageType.TYPING:
        await this.handleTyping(ws, message.payload)
        break

      case WSMessageType.PING:
        this.sendMessage(ws, { type: WSMessageType.PONG, payload: {} })
        break

      default:
        this.sendError(
          ws,
          'UNKNOWN_MESSAGE_TYPE',
          `Unknown message type: ${message.type}`
        )
    }
  }

  /**
   * Handle user authentication
   */
  private async handleAuthenticate(
    ws: WebSocket,
    payload: WSAuthenticatePayload
  ): Promise<void> {
    try {
      // Verify JWT token
      const decoded = jwt.verify(payload.token, this.jwtSecret) as {
        userId: string
      }

      // Verify user exists
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.userId },
      })

      if (!user) {
        this.sendError(ws, 'USER_NOT_FOUND', 'User not found')
        ws.close()
        return
      }

      // Add connection
      this.connectionManager.addConnection(ws, decoded.userId, payload.chatId)

      // Send authentication success
      this.sendMessage(ws, {
        type: WSMessageType.AUTHENTICATED,
        payload: {
          userId: decoded.userId,
          chatId: payload.chatId,
        },
      })

      log.info(`User ${decoded.userId} authenticated`)
    } catch (error) {
      this.sendError(ws, 'AUTH_FAILED', 'Authentication failed')
      ws.close()
    }
  }

  /**
   * Handle send message
   */
  private async handleSendMessage(
    ws: WebSocket,
    payload: WSSendMessagePayload
  ): Promise<void> {
    const connection = this.connectionManager.getConnection(ws)
    if (!connection) {
      this.sendError(ws, 'NOT_AUTHENTICATED', 'Not authenticated')
      return
    }

    try {
      // Verify chat access
      const chat = await this.messageService.getChat(payload.chatId)
      if (!chat) {
        this.sendError(ws, 'CHAT_NOT_FOUND', 'Chat not found')
        return
      }

      if (chat.userId !== connection.userId) {
        this.sendError(ws, 'UNAUTHORIZED', 'Unauthorized access to chat')
        return
      }

      // Save user message
      const userMessage = await this.messageService.createMessage({
        chatId: payload.chatId,
        content: payload.content,
        role: 'USER',
        userId: connection.userId,
      })

      // Broadcast user message to chat participants
      this.connectionManager.sendToChat(payload.chatId, {
        type: WSMessageType.MESSAGE_RECEIVED,
        payload: {
          id: userMessage.id,
          chatId: userMessage.chatId,
          content: userMessage.content,
          role: userMessage.role,
          userId: userMessage.userId || undefined,
          createdAt: userMessage.createdAt.toISOString(),
        },
      })

      // Get chat history for context
      const messages = await this.messageService.getChatMessages(
        payload.chatId,
        20
      )
      const chatHistory = messages.reverse().map(msg => ({
        role: msg.role,
        content: msg.content,
      }))

      // Send typing indicator
      this.connectionManager.sendToChat(payload.chatId, {
        type: WSMessageType.AGENT_TYPING,
        payload: {
          chatId: payload.chatId,
          agentId: chat.agentId,
          isTyping: true,
        },
      })

      // Generate agent response
      const agentResponseContent = await this.agentService.generateResponse({
        agentId: chat.agentId,
        chatId: payload.chatId,
        chatHistory,
      })

      // Save agent message
      const agentMessage = await this.messageService.createMessage({
        chatId: payload.chatId,
        content: agentResponseContent,
        role: 'AGENT',
        agentId: chat.agentId,
      })

      // Send agent response
      this.connectionManager.sendToChat(payload.chatId, {
        type: WSMessageType.AGENT_RESPONSE,
        payload: {
          id: agentMessage.id,
          chatId: agentMessage.chatId,
          content: agentMessage.content,
          role: agentMessage.role,
          agentId: agentMessage.agentId || undefined,
          createdAt: agentMessage.createdAt.toISOString(),
        },
      })
    } catch (error) {
      log.error(error, 'Error handling send message')
      this.sendError(ws, 'MESSAGE_FAILED', 'Failed to send message')
    }
  }

  /**
   * Handle typing indicator
   */
  private async handleTyping(ws: WebSocket, payload: any): Promise<void> {
    const connection = this.connectionManager.getConnection(ws)
    if (!connection) return

    // Broadcast typing indicator to other participants
    this.connectionManager.broadcastToChat(
      payload.chatId,
      {
        type: WSMessageType.TYPING,
        payload: {
          chatId: payload.chatId,
          userId: connection.userId,
          isTyping: payload.isTyping,
        },
      },
      ws
    )
  }

  /**
   * Send message to WebSocket client
   */
  private sendMessage(ws: WebSocket, message: WSMessage): void {
    this.connectionManager.sendToConnection(ws, message)
  }

  /**
   * Send error to WebSocket client
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    const errorPayload: WSErrorPayload = { code, message }
    this.sendMessage(ws, {
      type: WSMessageType.ERROR,
      payload: errorPayload,
    })
  }

  /**
   * Start periodic cleanup of stale connections
   */
  private startCleanupInterval(): void {
    this.cleanupTimer = setInterval(() => {
      this.connectionManager.cleanupStaleConnections()
    }, 60000)
  }

  /**
   * Handle HTTP upgrade to WebSocket
   */
  handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, ws => {
      this.wss.emit('connection', ws, request)
    })
  }

  /**
   * Get server statistics
   */
  getStats() {
    return {
      connections: this.connectionManager.getConnectionCount(),
      activeUsers: this.connectionManager.getActiveUsers().length,
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down chat server...')
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.wss.close()
    await this.prisma.$disconnect()
  }
}
