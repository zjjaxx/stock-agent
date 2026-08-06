import { type UIMessage } from 'ai';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class ChatDto {
  /** Latest UI message from the client (history is loaded from DB). */
  @IsObject()
  @IsNotEmpty()
  message: UIMessage;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsIn(['submit-message', 'regenerate-message'])
  trigger?: 'submit-message' | 'regenerate-message';

  @IsOptional()
  @IsString()
  messageId?: string;
}
