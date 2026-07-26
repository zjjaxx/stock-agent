import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { AgentModule } from '../agent/agent.module.js';
import { LLMModule } from '../llm/llm.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { ChatMessageEntity } from './entities/chat-message.entity.js';
import { ConversationEntity } from './entities/conversation.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatMessageEntity, ConversationEntity]),
    AgentModule,
    LLMModule,
    ToolsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
