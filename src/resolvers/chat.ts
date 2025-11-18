/**
 * Chat GraphQL Resolvers
 *
 * Resolvers for agent chat operations
 */

import type { PrismaClient } from '@prisma/client'
import { MessageService } from '../services/chat/messageService.js'
import type { Context } from './types.js'

const messageService = (prisma: PrismaClient) => new MessageService(prisma)

export const chatResolvers = {
  Query: {
    /**
     * Get agent by ID
     */
    agent: async (_: any, { id }: { id: string }, context: Context) => {
      return context.prisma.agent.findUnique({
        where: { id },
        include: {
          user: true,
          afFunction: true,
        },
      })
    },

    /**
     * Get agent by slug
     */
    agentBySlug: async (
      _: any,
      { slug }: { slug: string },
      context: Context
    ) => {
      return context.prisma.agent.findUnique({
        where: { slug },
        include: {
          user: true,
          afFunction: true,
        },
      })
    },

    /**
     * Get all agents (optionally filter by user)
     */
    agents: async (_: any, __: any, context: Context) => {
      const where = context.userId ? { userId: context.userId } : {}

      return context.prisma.agent.findMany({
        where,
        include: {
          user: true,
          afFunction: true,
        },
        orderBy: { createdAt: 'desc' },
      })
    },

    /**
     * Get chat by ID
     */
    chat: async (_: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      const chat = await context.prisma.chat.findUnique({
        where: { id },
        include: {
          user: true,
          agent: true,
        },
      })

      // Verify access
      if (chat && chat.userId !== context.userId) {
        throw new Error('Unauthorized')
      }

      return chat
    },

    /**
     * Get all chats for authenticated user
     */
    chats: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      return context.prisma.chat.findMany({
        where: { userId: context.userId },
        include: {
          agent: true,
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
      })
    },

    /**
     * Get messages for a chat
     */
    messages: async (
      _: any,
      {
        chatId,
        limit = 100,
        before,
      }: { chatId: string; limit?: number; before?: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      // Verify chat access
      const chat = await context.prisma.chat.findUnique({
        where: { id: chatId },
      })

      if (!chat || chat.userId !== context.userId) {
        throw new Error('Unauthorized')
      }

      return messageService(context.prisma).getChatMessages(
        chatId,
        limit,
        before
      )
    },
  },

  Mutation: {
    /**
     * Create a new agent
     */
    createAgent: async (
      _: any,
      {
        input,
      }: {
        input: {
          name: string
          slug: string
          description?: string
          systemPrompt?: string
          model?: string
          functionId?: string
        }
      },
      context: Context
    ) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      return context.prisma.agent.create({
        data: {
          userId: context.userId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          systemPrompt: input.systemPrompt,
          model: input.model || 'gpt-4',
          functionId: input.functionId,
          status: 'ACTIVE',
        },
        include: {
          user: true,
          afFunction: true,
        },
      })
    },

    /**
     * Create a new chat
     */
    createChat: async (
      _: any,
      { input }: { input: { agentId: string; title?: string } },
      context: Context
    ) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      // Verify agent exists
      const agent = await context.prisma.agent.findUnique({
        where: { id: input.agentId },
      })

      if (!agent) {
        throw new Error('Agent not found')
      }

      return messageService(context.prisma).createChat(
        context.userId,
        input.agentId,
        input.title
      )
    },

    /**
     * Send a message (for non-WebSocket clients)
     */
    sendMessage: async (
      _: any,
      { input }: { input: { chatId: string; content: string } },
      context: Context
    ) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      // Verify chat access
      const chat = await context.prisma.chat.findUnique({
        where: { id: input.chatId },
        include: { agent: true },
      })

      if (!chat || chat.userId !== context.userId) {
        throw new Error('Unauthorized')
      }

      // Create user message
      const message = await messageService(context.prisma).createMessage({
        chatId: input.chatId,
        content: input.content,
        role: 'USER',
        userId: context.userId,
      })

      // Note: For WebSocket clients, agent response is handled by WebSocket server
      // For GraphQL-only clients, we could generate response here

      return message
    },

    /**
     * Delete a chat
     */
    deleteChat: async (_: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        throw new Error('Authentication required')
      }

      // Verify ownership
      const chat = await context.prisma.chat.findUnique({
        where: { id },
      })

      if (!chat || chat.userId !== context.userId) {
        throw new Error('Unauthorized')
      }

      await messageService(context.prisma).deleteChat(id)
      return true
    },
  },

  // Field resolvers
  Agent: {
    chats: async (parent: any, _: any, context: Context) => {
      return context.prisma.chat.findMany({
        where: { agentId: parent.id },
        orderBy: { lastMessageAt: 'desc' },
      })
    },
  },

  Chat: {
    messages: async (parent: any, _: any, context: Context) => {
      return context.prisma.message.findMany({
        where: { chatId: parent.id },
        orderBy: { createdAt: 'asc' },
        take: 50,
      })
    },
  },

  Message: {
    attachments: async (parent: any, _: any, context: Context) => {
      return context.prisma.attachment.findMany({
        where: { messageId: parent.id },
      })
    },
  },
}
