import { Module } from '@nestjs/common';
import { LLMProvider, LLM_TOKEN } from './llm.provider.js';

@Module({
  providers: [LLMProvider],
  exports: [LLM_TOKEN],
})
export class LLMModule {}
