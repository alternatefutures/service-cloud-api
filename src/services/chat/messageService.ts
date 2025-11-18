/**
 * Message Persistence Service
 *
 * Handles database operations for chats, messages, and agents
 */

import type { PrismaClient } from '@prisma/client'

export class MessageService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new chat
   */
  async createChat(userId: string, agentId: string, title?: string) {
    return this.prisma.chat.create({
      data: {
        userId,
        agentId,
        title,
      },
      include: {
        agent: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
    })
  }

  /**
   * Get a chat by ID
   */
  async getChat(chatId: string) {
    return this.prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        agent: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
    })
  }

  /**
   * Get all chats for a user
   */
  async getUserChats(userId: string, limit = 50) {
    return this.prisma.chat.findMany({
      where: { userId },
      include: {
        agent: true,
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
    })
  }

  /**
   * Create a new message
   */
  async createMessage(data: {
    chatId: string
    content: string
    role: 'USER' | 'AGENT' | 'SYSTEM'
    userId?: string
    agentId?: string
    metadata?: any
  }) {
    const message = await this.prisma.message.create({
      data: {
        chatId: data.chatId,
        content: data.content,
        role: data.role,
        userId: data.userId,
        agentId: data.agentId,
        metadata: data.metadata,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        agent: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
    })

    // Update chat's lastMessageAt
    await this.prisma.chat.update({
      where: { id: data.chatId },
      data: { lastMessageAt: new Date() },
    })

    return message
  }

  /**
   * Get messages for a chat
   */
  async getChatMessages(chatId: string, limit = 100, before?: string) {
    return this.prisma.message.findMany({
      where: {
        chatId,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        agent: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
        attachments: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  /**
   * Get or create agent
   */
  async getOrCreateAgent(data: {
    userId: string
    name: string
    slug: string
    description?: string
    systemPrompt?: string
    model?: string
  }) {
    // Try to find existing agent
    let agent = await this.prisma.agent.findUnique({
      where: { slug: data.slug },
    })

    if (!agent) {
      // Create new agent
      agent = await this.prisma.agent.create({
        data: {
          userId: data.userId,
          name: data.name,
          slug: data.slug,
          description: data.description,
          systemPrompt: data.systemPrompt,
          model: data.model || 'gpt-4',
          status: 'ACTIVE',
        },
      })
    }

    return agent
  }

  /**
   * Get agent by ID
   */
  async getAgent(agentId: string) {
    return this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        afFunction: true,
      },
    })
  }

  /**
   * Get agent by slug
   */
  async getAgentBySlug(slug: string) {
    return this.prisma.agent.findUnique({
      where: { slug },
      include: {
        afFunction: true,
      },
    })
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(
    agentId: string,
    status: 'ACTIVE' | 'INACTIVE' | 'TRAINING' | 'ERROR'
  ) {
    return this.prisma.agent.update({
      where: { id: agentId },
      data: { status },
    })
  }

  /**
   * Delete a chat and all its messages
   */
  async deleteChat(chatId: string) {
    return this.prisma.chat.delete({
      where: { id: chatId },
    })
  }

  /**
   * Get chat statistics
   */
  async getChatStats(chatId: string) {
    const [messageCount, chat] = await Promise.all([
      this.prisma.message.count({
        where: { chatId },
      }),
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          createdAt: true,
          lastMessageAt: true,
        },
      }),
    ])

    return {
      messageCount,
      createdAt: chat?.createdAt,
      lastMessageAt: chat?.lastMessageAt,
    }
  }

  /**
   * Search messages
   */
  async searchMessages(userId: string, query: string, limit = 20) {
    return this.prisma.message.findMany({
      where: {
        chat: {
          userId,
        },
        content: {
          contains: query,
          mode: 'insensitive',
        },
      },
      include: {
        chat: {
          include: {
            agent: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }
}
