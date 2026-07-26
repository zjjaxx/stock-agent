import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  HttpCode,
  Header,
} from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatDto } from './dto/chat.dto.js';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @HttpCode(200)
  async chat(@Body() chatDto: ChatDto, @Res() res: Response) {
    const { conversationId, stream } =
      await this.chatService.chatStream(chatDto);

    res.setHeader('X-Conversation-Id', conversationId);
    res.setHeader('Access-Control-Expose-Headers', 'X-Conversation-Id');

    pipeUIMessageStreamToResponse({
      response: res,
      stream,
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async listConversations() {
    return this.chatService.listConversations();
  }

  @Get(':conversationId')
  @Header('Cache-Control', 'no-store')
  async getHistory(@Param('conversationId') conversationId: string) {
    return this.chatService.getHistory(conversationId);
  }
}
