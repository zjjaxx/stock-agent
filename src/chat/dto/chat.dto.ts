import { UIMessage } from 'ai';
import { IsArray, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class ChatDto {
  @IsArray()
  @IsNotEmpty()
  messages: UIMessage[];

  @IsOptional()
  @IsString()
  conversationId?: string;
}
