import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ConversationEntity } from './conversation.entity.js';

@Entity('chat_messages')
@Index(['conversationId', 'createdAt'])
export class ChatMessageEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Index()
  @Column({ name: 'conversation_id', type: 'varchar', length: 64 })
  conversationId: string;

  @ManyToOne(
    () => ConversationEntity,
    (conversation) => conversation.messages,
    {
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'conversation_id' })
  conversation: ConversationEntity;

  @Column({ type: 'varchar', length: 32 })
  role: string;

  @Column({ type: 'jsonb' })
  parts: Record<string, any>[];

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
