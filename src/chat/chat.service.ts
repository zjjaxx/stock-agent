import {
  BadRequestException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { DeepAgent } from 'deepagents';
import { createUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { ChatDto } from './dto/chat.dto.js';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { AGENT_TOKEN } from '../agent/agent.provider.js';
import { ChatMessageEntity } from './entities/chat-message.entity.js';
import { ConversationEntity } from './entities/conversation.entity.js';

export type SubagentStreamData = {
  id: string;
  name: string;
  namespace: string[];
  status: 'running' | 'complete';
  reasoning: string;
  text: string;
};

type ChatDataParts = {
  subagent: SubagentStreamData;
};

type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
type ChatUIMessageChunk = UIMessageChunk<unknown, ChatDataParts>;

type SubagentMessageEvent = {
  data: [unknown, Record<string, unknown>];
  name: string;
  namespace: string[];
};

function getSubagentMessageEvent(event: unknown): SubagentMessageEvent | null {
  if (!Array.isArray(event) || event.length !== 3) {
    return null;
  }

  const eventParts = event as unknown[];
  const namespace = eventParts[0];
  const mode = eventParts[1];
  const data = eventParts[2];
  if (
    !Array.isArray(namespace) ||
    mode !== 'messages' ||
    !Array.isArray(data) ||
    data.length !== 2
  ) {
    return null;
  }

  const dataParts = data as unknown[];
  const metadata = dataParts[1];
  if (metadata == null || typeof metadata !== 'object') {
    return null;
  }

  const name = (metadata as Record<string, unknown>).lc_agent_name;
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }

  return {
    data: [dataParts[0], metadata as Record<string, unknown>],
    name,
    namespace: namespace.filter(
      (part): part is string => typeof part === 'string',
    ),
  };
}

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
    stream: ReadableStream<ChatUIMessageChunk>;
  }> {
    const incoming = chatDto.message;
    if (incoming == null || typeof incoming !== 'object') {
      throw new BadRequestException('message is required');
    }

    const conversationId = chatDto.conversationId ?? randomUUID();
    const messages = await this.resolveMessages(conversationId, chatDto);

    const stream = createUIMessageStream<ChatUIMessage>({
      originalMessages: messages as ChatUIMessage[],
      execute: async ({ writer }) => {
        const langchainMessages = await toBaseMessages(messages);
        const agentStream = await this.agentProvider.stream(
          { messages: langchainMessages },
          {
            streamMode: ['values', 'messages', 'tools'],
            subgraphs: true,
          },
        );
        const subagents = new Map<string, SubagentStreamData>();
        const rootAgentStream = agentStream.pipeThrough(
          new TransformStream({
            transform: (event, controller) => {
              const subagentEvent = getSubagentMessageEvent(event);
              if (!subagentEvent) {
                controller.enqueue(event);
                return;
              }
            },
            flush: () => {
              for (const [id, subagent] of subagents) {
                writer.write({
                  type: 'data-subagent',
                  id,
                  data: { ...subagent, status: 'complete' },
                });
              }
            },
          }),
        );

        writer.merge(
          toUIMessageStream(
            rootAgentStream,
          ) as ReadableStream<ChatUIMessageChunk>,
        );
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

    const messages = await this.loadMessages(conversationId);

    return {
      conversationId,
      title: conversation.title,
      messages,
    };
  }

  /**
   * Build the full message list for the agent from DB history + the latest
   * client message. Persist the incoming user message when needed.
   */
  private async resolveMessages(
    conversationId: string,
    chatDto: ChatDto,
  ): Promise<UIMessage[]> {
    const incoming = chatDto.message;
    await this.ensureConversation(conversationId, [incoming]);

    const previousMessages = await this.loadMessages(conversationId);
    const isRegenerate = chatDto.trigger === 'regenerate-message';

    if (isRegenerate) {
      const anchorIndex = previousMessages.findIndex(
        (message) => message.id === incoming.id,
      );

      if (anchorIndex >= 0) {
        await this.deleteMessagesAfter(conversationId, incoming.id);
        return previousMessages.slice(0, anchorIndex + 1);
      }

      // Incoming user message not yet persisted (edge case).
      await this.upsertMessages(conversationId, [incoming]);
      return [...previousMessages, incoming];
    }

    const existingIndex = previousMessages.findIndex(
      (message) => message.id === incoming.id,
    );
    if (existingIndex >= 0) {
      await this.upsertMessages(conversationId, [incoming]);
      const next = [...previousMessages];
      next[existingIndex] = incoming;
      return next;
    }

    await this.upsertMessages(conversationId, [incoming]);
    return [...previousMessages, incoming];
  }

  private async loadMessages(conversationId: string): Promise<UIMessage[]> {
    const rows = await this.chatMessageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => this.toUIMessage(row));
  }

  private async deleteMessagesAfter(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const rows = await this.chatMessageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      select: { id: true },
    });
    const index = rows.findIndex((row) => row.id === messageId);
    if (index < 0 || index === rows.length - 1) {
      return;
    }

    const idsToDelete = rows.slice(index + 1).map((row) => row.id);
    await this.chatMessageRepo.delete({ id: In(idsToDelete) });
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
