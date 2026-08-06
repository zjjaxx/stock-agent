import { Provider } from '@nestjs/common';
import { LLM_TOKEN } from '../llm/llm.provider.js';
import { ChatDeepSeek } from '@langchain/deepseek';
import { AnySubAgent, createDeepAgent } from 'deepagents';
import { mainAgentPrompt } from '../prompt/index.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { SEARCH_AGENT_TOKEN } from './subagents/search.provider.js';
import { TIME_TOOL_TOKEN } from '../tools/time.provider.js';
import { createAgentBackend } from './backend.js';

export const AGENT_TOKEN = 'agent';
export const AgentProvider: Provider = {
  provide: AGENT_TOKEN,
  useFactory: (
    llmProvider: ChatDeepSeek,
    searchAgent: AnySubAgent,
    timeTool: DynamicStructuredTool,
  ) => {
    return createDeepAgent({
      model: llmProvider,
      systemPrompt: mainAgentPrompt,
      tools: [timeTool],
      backend: createAgentBackend(),
      subagents: [searchAgent],
    });
  },
  inject: [LLM_TOKEN, SEARCH_AGENT_TOKEN, TIME_TOOL_TOKEN],
};
