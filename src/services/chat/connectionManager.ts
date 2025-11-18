/**
 * WebSocket Connection Manager
 *
 * Manages active WebSocket connections, user sessions, and message routing
 */

import type { WebSocket } from 'ws'
import type { ConnectionMetadata, WSMessage } from './types.js'

export class ConnectionManager {
  private connections: Map<WebSocket, ConnectionMetadata>
  private userConnections: Map<string, Set<WebSocket>>
  private chatConnections: Map<string, Set<WebSocket>>

  constructor() {
    this.connections = new Map()
    this.userConnections = new Map()
    this.chatConnections = new Map()
  }

  /**
   * Add a new WebSocket connection
   */
  addConnection(ws: WebSocket, userId: string, chatId?: string): void {
    const metadata: ConnectionMetadata = {
      userId,
      chatId,
      connectedAt: new Date(),
      lastActivity: new Date(),
    }

    this.connections.set(ws, metadata)

    // Track by user
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set())
    }
    this.userConnections.get(userId)!.add(ws)

    // Track by chat
    if (chatId) {
      if (!this.chatConnections.has(chatId)) {
        this.chatConnections.set(chatId, new Set())
      }
      this.chatConnections.get(chatId)!.add(ws)
    }

    console.log(
      `✅ Connection added for user ${userId} in chat ${chatId || 'none'}`
    )
  }

  /**
   * Remove a WebSocket connection
   */
  removeConnection(ws: WebSocket): void {
    const metadata = this.connections.get(ws)
    if (!metadata) return

    // Remove from user connections
    const userSockets = this.userConnections.get(metadata.userId)
    if (userSockets) {
      userSockets.delete(ws)
      if (userSockets.size === 0) {
        this.userConnections.delete(metadata.userId)
      }
    }

    // Remove from chat connections
    if (metadata.chatId) {
      const chatSockets = this.chatConnections.get(metadata.chatId)
      if (chatSockets) {
        chatSockets.delete(ws)
        if (chatSockets.size === 0) {
          this.chatConnections.delete(metadata.chatId)
        }
      }
    }

    this.connections.delete(ws)
    console.log(`❌ Connection removed for user ${metadata.userId}`)
  }

  /**
   * Get connection metadata for a WebSocket
   */
  getConnection(ws: WebSocket): ConnectionMetadata | undefined {
    return this.connections.get(ws)
  }

  /**
   * Update last activity time for a connection
   */
  updateActivity(ws: WebSocket): void {
    const metadata = this.connections.get(ws)
    if (metadata) {
      metadata.lastActivity = new Date()
    }
  }

  /**
   * Send message to a specific user (all their connections)
   */
  sendToUser(userId: string, message: WSMessage): void {
    const sockets = this.userConnections.get(userId)
    if (!sockets) return

    const messageStr = JSON.stringify(message)
    sockets.forEach(ws => {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(messageStr)
      }
    })
  }

  /**
   * Send message to all connections in a chat
   */
  sendToChat(chatId: string, message: WSMessage): void {
    const sockets = this.chatConnections.get(chatId)
    if (!sockets) return

    const messageStr = JSON.stringify(message)
    sockets.forEach(ws => {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(messageStr)
      }
    })
  }

  /**
   * Send message to a specific connection
   */
  sendToConnection(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(JSON.stringify(message))
    }
  }

  /**
   * Broadcast message to all connections except sender
   */
  broadcastToChat(
    chatId: string,
    message: WSMessage,
    except?: WebSocket
  ): void {
    const sockets = this.chatConnections.get(chatId)
    if (!sockets) return

    const messageStr = JSON.stringify(message)
    sockets.forEach(ws => {
      if (ws !== except && ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(messageStr)
      }
    })
  }

  /**
   * Get active connection count
   */
  getConnectionCount(): number {
    return this.connections.size
  }

  /**
   * Get connections for a specific chat
   */
  getChatConnections(chatId: string): number {
    return this.chatConnections.get(chatId)?.size || 0
  }

  /**
   * Get all active user IDs
   */
  getActiveUsers(): string[] {
    return Array.from(this.userConnections.keys())
  }

  /**
   * Check if a user is online
   */
  isUserOnline(userId: string): boolean {
    return this.userConnections.has(userId)
  }

  /**
   * Clean up stale connections
   */
  cleanupStaleConnections(maxIdleTime: number = 300000): number {
    const now = new Date().getTime()
    let cleaned = 0

    this.connections.forEach((metadata, ws) => {
      const idleTime = now - metadata.lastActivity.getTime()
      if (idleTime > maxIdleTime) {
        this.removeConnection(ws)
        ws.close()
        cleaned++
      }
    })

    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} stale connections`)
    }

    return cleaned
  }
}
