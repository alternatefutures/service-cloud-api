import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageService } from './messageService.js';
import type { PrismaClient } from '@prisma/client';

describe('MessageService', () => {
  let mockPrisma: any;
  let messageService: MessageService;

  beforeEach(() => {
    // Create mock Prisma client
    mockPrisma = {
      chat: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      message: {
        create: vi.fn(),
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      agent: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as PrismaClient;

    messageService = new MessageService(mockPrisma);
  });

  describe('createChat', () => {
    it('should create a new chat', async () => {
      const mockChat = {
        id: 'chat-123',
        userId: 'user-123',
        agentId: 'agent-123',
        title: 'Test Chat',
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { id: 'agent-123', name: 'Test Agent' },
        user: { id: 'user-123', email: 'test@example.com' },
      };

      mockPrisma.chat.create.mockResolvedValue(mockChat);

      const result = await messageService.createChat('user-123', 'agent-123', 'Test Chat');

      expect(result).toEqual(mockChat);
      expect(mockPrisma.chat.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          agentId: 'agent-123',
          title: 'Test Chat',
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
      });
    });
  });

  describe('createMessage', () => {
    it('should create a user message and update chat timestamp', async () => {
      const mockMessage = {
        id: 'msg-123',
        chatId: 'chat-123',
        content: 'Hello!',
        role: 'USER',
        userId: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.message.create.mockResolvedValue(mockMessage);
      mockPrisma.chat.update.mockResolvedValue({});

      const result = await messageService.createMessage({
        chatId: 'chat-123',
        content: 'Hello!',
        role: 'USER',
        userId: 'user-123',
      });

      expect(result).toEqual(mockMessage);
      expect(mockPrisma.message.create).toHaveBeenCalled();
      expect(mockPrisma.chat.update).toHaveBeenCalledWith({
        where: { id: 'chat-123' },
        data: { lastMessageAt: expect.any(Date) },
      });
    });

    it('should create an agent message', async () => {
      const mockMessage = {
        id: 'msg-456',
        chatId: 'chat-123',
        content: 'AI response',
        role: 'AGENT',
        agentId: 'agent-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.message.create.mockResolvedValue(mockMessage);
      mockPrisma.chat.update.mockResolvedValue({});

      const result = await messageService.createMessage({
        chatId: 'chat-123',
        content: 'AI response',
        role: 'AGENT',
        agentId: 'agent-123',
      });

      expect(result).toEqual(mockMessage);
      expect(mockPrisma.message.create).toHaveBeenCalled();
    });
  });

  describe('getChatMessages', () => {
    it('should retrieve messages for a chat', async () => {
      const mockMessages = [
        {
          id: 'msg-1',
          chatId: 'chat-123',
          content: 'Hello',
          role: 'USER',
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 'msg-2',
          chatId: 'chat-123',
          content: 'Hi there!',
          role: 'AGENT',
          createdAt: new Date('2024-01-02'),
        },
      ];

      mockPrisma.message.findMany.mockResolvedValue(mockMessages);

      const result = await messageService.getChatMessages('chat-123', 50);

      expect(result).toEqual(mockMessages);
      expect(mockPrisma.message.findMany).toHaveBeenCalledWith({
        where: { chatId: 'chat-123' },
        orderBy: { createdAt: 'desc' },
        take: 50,
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
      });
    });

    it('should support pagination with before parameter', async () => {
      mockPrisma.message.findMany.mockResolvedValue([]);
      const beforeDate = '2024-01-01T00:00:00.000Z';

      await messageService.getChatMessages('chat-123', 20, beforeDate);

      expect(mockPrisma.message.findMany).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-123',
          createdAt: { lt: new Date(beforeDate) },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
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
      });
    });
  });

  describe('getUserChats', () => {
    it('should retrieve all chats for a user', async () => {
      const mockChats = [
        {
          id: 'chat-1',
          userId: 'user-123',
          agentId: 'agent-1',
          title: 'Chat 1',
          lastMessageAt: new Date(),
        },
        {
          id: 'chat-2',
          userId: 'user-123',
          agentId: 'agent-2',
          title: 'Chat 2',
          lastMessageAt: new Date(),
        },
      ];

      mockPrisma.chat.findMany.mockResolvedValue(mockChats);

      const result = await messageService.getUserChats('user-123');

      expect(result).toEqual(mockChats);
      expect(mockPrisma.chat.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        include: {
          agent: true,
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 50,
      });
    });
  });

  describe('deleteChat', () => {
    it('should delete a chat (cascade deletes messages)', async () => {
      mockPrisma.chat.delete.mockResolvedValue({});

      await messageService.deleteChat('chat-123');

      expect(mockPrisma.chat.delete).toHaveBeenCalledWith({
        where: { id: 'chat-123' },
      });
      // Messages are cascade deleted by Prisma based on schema
    });
  });

  describe('getAgent', () => {
    it('should retrieve an agent by ID', async () => {
      const mockAgent = {
        id: 'agent-123',
        name: 'Test Agent',
        slug: 'test-agent',
        model: 'gpt-4',
        systemPrompt: 'You are a helpful assistant',
        status: 'ACTIVE',
      };

      mockPrisma.agent.findUnique.mockResolvedValue(mockAgent);

      const result = await messageService.getAgent('agent-123');

      expect(result).toEqual(mockAgent);
      expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'agent-123' },
        include: {
          afFunction: true,
        },
      });
    });
  });
});
