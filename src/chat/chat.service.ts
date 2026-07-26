import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { DeepAgent } from 'deepagents';
import { createUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { ChatDto } from './dto/chat.dto.js';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { AGENT_TOKEN } from '../agent/agent.provider.js';
import { ChatMessageEntity } from './entities/chat-message.entity.js';
import { ConversationEntity } from './entities/conversation.entity.js';

@Injectable()
export class ChatService {
  constructor(
    @Inject(AGENT_TOKEN) private readonly agentProvider: DeepAgent,
    @InjectRepository(ChatMessageEntity)
    private readonly chatMessageRepo: Repository<ChatMessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
  ) {}

  async chatStream(chatDto: ChatDto): Promise<{
    conversationId: string;
    stream: ReadableStream<UIMessageChunk>;
  }> {
    const conversationId = chatDto.conversationId ?? randomUUID();
    await this.ensureConversation(conversationId, chatDto.messages);
    await this.upsertMessages(conversationId, chatDto.messages);
    const stream = createUIMessageStream({
      originalMessages: chatDto.messages,
      execute: async ({ writer }) => {
        const langchainMessages = await toBaseMessages(chatDto.messages);
        const agentStream = await this.agentProvider.stream(
          { messages: langchainMessages },
          {
            streamMode: ['values', 'messages'],
          },
        );
        writer.merge(toUIMessageStream(agentStream));
      },
      onFinish: async ({ responseMessage }) => {
        await this.upsertMessages(conversationId, [responseMessage]);
        await this.touchConversation(conversationId);
      },
    });

    return { conversationId, stream };
  }

  async listConversations(): Promise<
    Pick<ConversationEntity, 'id' | 'title' | 'createdAt' | 'updatedAt'>[]
  > {
    return this.conversationRepo.find({
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
      order: { updatedAt: 'DESC' },
    });
  }

  async getHistory(conversationId: string): Promise<{
    conversationId: string;
    title: string | null;
    messages: UIMessage[];
  }> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const rows = await this.chatMessageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });

    return {
      conversationId,
      title: conversation.title,
      messages: rows.map((row) => this.toUIMessage(row)),
    };
  }

  private async ensureConversation(
    conversationId: string,
    messages: UIMessage[],
  ): Promise<void> {
    const existing = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (existing) {
      await this.touchConversation(conversationId);
      return;
    }

    await this.conversationRepo.insert({
      id: conversationId,
      title: this.deriveTitle(messages),
      metadata: null,
    });
  }

  private async touchConversation(conversationId: string): Promise<void> {
    await this.conversationRepo.update(conversationId, {
      updatedAt: new Date(),
    });
  }

  private deriveTitle(messages: UIMessage[]): string | null {
    const userMessage = messages.find((message) => message.role === 'user');
    if (!userMessage) {
      return null;
    }

    const textPart = userMessage.parts.find(
      (part): part is { type: 'text'; text: string } => part.type === 'text',
    );
    if (!textPart?.text) {
      return null;
    }

    const text = textPart.text.trim();
    return text.length > 50 ? `${text.slice(0, 50)}...` : text;
  }

  private async upsertMessages(
    conversationId: string,
    messages: UIMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const now = new Date();
    const entities = messages.map((message) =>
      this.chatMessageRepo.create({
        id: message.id || randomUUID(),
        conversationId,
        role: message.role,
        parts: message.parts as Record<string, any>[],
        metadata: (message.metadata as Record<string, any> | undefined) ?? null,
        updatedAt: now,
      }),
    );

    await this.chatMessageRepo.upsert(entities, ['id']);
  }

  private toUIMessage(row: ChatMessageEntity): UIMessage {
    return {
      id: row.id,
      role: row.role as UIMessage['role'],
      parts: row.parts as UIMessage['parts'],
      ...(row.metadata != null
        ? { metadata: row.metadata as UIMessage['metadata'] }
        : {}),
    };
  }
}
