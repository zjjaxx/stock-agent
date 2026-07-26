import { Module } from '@nestjs/common';
import { AgentProvider } from './agent.provider.js';
import { LLMModule } from '../llm/llm.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { SearchAgentProvider } from './subagents/search.provider.js';

@Module({
  imports: [LLMModule, ToolsModule],
  providers: [SearchAgentProvider, AgentProvider],
  exports: [AgentProvider],
})
export class AgentModule {}
