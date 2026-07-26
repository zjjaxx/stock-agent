import { AnySubAgent } from 'deepagents';
import { Provider } from '@nestjs/common';
import { LLM_TOKEN } from '../../llm/llm.provider.js';
import { ChatDeepSeek } from '@langchain/deepseek';
import { searchAgentPrompt } from '../../prompt/index.js';
import { WEB_TOOL_TOKEN } from '../../tools/web.provider.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
export const SEARCH_AGENT_TOKEN = 'searchAgent';
export const SearchAgentProvider: Provider = {
  provide: SEARCH_AGENT_TOKEN,
  useFactory: (
    llmProvider: ChatDeepSeek,
    webTool: DynamicStructuredTool,
  ): AnySubAgent => {
    return {
      model: llmProvider,
      name: SEARCH_AGENT_TOKEN,
      description: '一个可以用opencli查询各种股票信息的子agent',
      systemPrompt: searchAgentPrompt,
      tools: [webTool],
    };
  },
  inject: [LLM_TOKEN, WEB_TOOL_TOKEN],
};
