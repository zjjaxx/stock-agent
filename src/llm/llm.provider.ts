import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatDeepSeek } from '@langchain/deepseek';
export const LLM_TOKEN = 'llm';
export const LLMProvider: Provider = {
  provide: LLM_TOKEN,
  useFactory: (configService: ConfigService) => {
    const llm = new ChatDeepSeek({
      model: configService.get<string>('LLM_MODEL', 'deepseek-v4-pro'),
      apiKey: configService.get<string>('LLM_API_KEY'),
    });
    return llm;
  },
  inject: [ConfigService],
};
