/**
 * Agent Service
 *
 * Handles agent response generation and integration with AI backends
 * Currently uses mock responses - will integrate with Eliza or other agent frameworks
 */

import type { PrismaClient } from '@prisma/client';

export interface AgentContext {
  agentId: string;
  chatId: string;
  systemPrompt?: string;
  model?: string;
  chatHistory: Array<{
    role: string;
    content: string;
  }>;
}

export class AgentService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Generate agent response
   *
   * In production, this would:
   * 1. Connect to Eliza agent or custom agent framework
   * 2. Load agent configuration and context
   * 3. Generate response using AI model
   * 4. Return streaming or complete response
   *
   * Currently returns mock responses for demonstration
   */
  async generateResponse(context: AgentContext): Promise<string> {
    // Get agent details
    const agent = await this.prisma.agent.findUnique({
      where: { id: context.agentId },
    });

    if (!agent) {
      throw new Error('Agent not found');
    }

    // Mock response logic - replace with actual AI integration
    const response = await this.mockAgentResponse(
      context.chatHistory,
      agent.name,
      agent.systemPrompt || ''
    );

    return response;
  }

  /**
   * Mock agent response generator
   * TODO: Replace with actual Eliza/AI integration
   */
  private async mockAgentResponse(
    chatHistory: Array<{ role: string; content: string }>,
    agentName: string,
    systemPrompt: string
  ): Promise<string> {
    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1500));

    // Get the last user message
    const lastUserMessage = chatHistory
      .slice()
      .reverse()
      .find((msg) => msg.role === 'USER');

    if (!lastUserMessage) {
      return `Hello! I'm ${agentName}. How can I help you today?`;
    }

    const userInput = lastUserMessage.content.toLowerCase();

    // Simple pattern matching for mock responses
    if (userInput.includes('hello') || userInput.includes('hi')) {
      return `Hello! I'm ${agentName}, your AI assistant. What would you like to know?`;
    }

    if (userInput.includes('help')) {
      return `I'm here to help! I can assist you with:\n- Answering questions\n- Providing information\n- Having a conversation\n\nWhat specific topic would you like help with?`;
    }

    if (userInput.includes('deploy') || userInput.includes('site')) {
      return `To deploy a site on Alternate Futures, you can use our deployment API or the web interface. Would you like me to walk you through the deployment process?`;
    }

    if (userInput.includes('function')) {
      return `Alternate Futures Functions allow you to run serverless code on our decentralized infrastructure. You can deploy JavaScript/TypeScript functions that respond to HTTP requests. Would you like to know more about creating a function?`;
    }

    if (userInput.includes('storage') || userInput.includes('ipfs')) {
      return `We support multiple decentralized storage options including IPFS, Arweave, and Filecoin. Each has different characteristics:\n- IPFS: Fast, content-addressed, suitable for frequently accessed content\n- Arweave: Permanent storage with one-time payment\n- Filecoin: Long-term storage with proof of storage\n\nWhich would you like to learn more about?`;
    }

    if (userInput.includes('price') || userInput.includes('cost')) {
      return `Our pricing is based on usage:\n- Storage: Varies by provider (IPFS/Arweave/Filecoin)\n- Functions: Charged per execution time\n- Bandwidth: Included up to reasonable limits\n\nWould you like specific pricing details?`;
    }

    if (userInput.includes('thank')) {
      return `You're welcome! Feel free to ask if you have any other questions.`;
    }

    // Default contextual response
    return `I understand you're asking about "${lastUserMessage.content}". Based on our conversation, here's what I can tell you:\n\nAlternate Futures is a decentralized platform for deploying sites and serverless functions with built-in storage on IPFS, Arweave, and Filecoin.\n\nCould you provide more details about what specifically you'd like to know?`;
  }

  /**
   * Stream agent response (for future implementation)
   * TODO: Implement streaming responses for better UX
   */
  async *streamResponse(context: AgentContext): AsyncGenerator<string> {
    const response = await this.generateResponse(context);

    // Simulate streaming by yielding chunks
    const words = response.split(' ');
    for (const word of words) {
      yield word + ' ';
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Check if agent is available
   */
  async isAgentAvailable(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { status: true },
    });

    return agent?.status === 'ACTIVE';
  }

  /**
   * Get agent capabilities
   */
  async getAgentCapabilities(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        afFunction: true,
      },
    });

    if (!agent) {
      throw new Error('Agent not found');
    }

    return {
      canChat: true,
      canExecuteCode: !!agent.afFunction,
      canAccessFiles: false, // TODO: Implement file access
      model: agent.model,
      systemPrompt: agent.systemPrompt,
    };
  }
}
