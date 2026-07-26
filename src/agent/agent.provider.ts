import { Provider } from '@nestjs/common';
import { LLM_TOKEN } from '../llm/llm.provider.js';
import { ChatDeepSeek } from '@langchain/deepseek';
import { createDeepAgent } from 'deepagents';
import { mainAgentPrompt } from '../prompt/index.js';
import { AnySubAgent } from 'deepagents';
import { SEARCH_AGENT_TOKEN } from './subagents/search.provider.js';
export const AGENT_TOKEN = 'agent';
export const AgentProvider: Provider = {
  provide: AGENT_TOKEN,
  useFactory: (llmProvider: ChatDeepSeek, searchAgent: AnySubAgent) => {
    return createDeepAgent({
      model: llmProvider,
      systemPrompt: mainAgentPrompt,
      subagents: [searchAgent],
    });
  },
  inject: [LLM_TOKEN, SEARCH_AGENT_TOKEN],
};
