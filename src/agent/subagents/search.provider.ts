import { AnySubAgent } from 'deepagents';
import { Provider } from '@nestjs/common';
import { LLM_TOKEN } from '../../llm/llm.provider.js';
import { ChatDeepSeek } from '@langchain/deepseek';
import { searchAgentPrompt } from '../../prompt/index.js';
import { WEB_TOOL_TOKEN } from '../../tools/web.provider.js';
import { TIME_TOOL_TOKEN } from '../../tools/time.provider.js';
import { DynamicStructuredTool } from '@langchain/core/tools';

export const SEARCH_AGENT_TOKEN = 'searchAgent';
export const SearchAgentProvider: Provider = {
  provide: SEARCH_AGENT_TOKEN,
  useFactory: (
    llmProvider: ChatDeepSeek,
    webTool: DynamicStructuredTool,
    timeTool: DynamicStructuredTool,
  ): AnySubAgent => {
    return {
      model: llmProvider,
      name: SEARCH_AGENT_TOKEN,
      description:
        '股票查询与分析子 Agent：按任务加载 /src/skills/（smart-search/opencli 检索选股与事实、rightside 右侧交易技术位分析），查证事实并完成分析；必要时 BochaWebSearch 兜底。',
      systemPrompt: searchAgentPrompt,
      tools: [timeTool],
      skills: ['/src/skills/'],
      // 不用 permissions：LocalShell + permissions 时 resolveBackend 会丢掉
      // routePrefixes，execute（opencli）直接失败。项目隔离靠 createAgentBackend
      // 的路由：/src/skills、/tmp、/large_tool_results 可访问，其余进 .fs-jail。
    };
  },
  inject: [LLM_TOKEN, WEB_TOOL_TOKEN, TIME_TOOL_TOKEN],
};
