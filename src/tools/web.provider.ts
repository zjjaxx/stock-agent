import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createBochaWebSearchTool } from './web.js';
export const WEB_TOOL_TOKEN = 'webTool';
export const WebToolProvider: Provider = {
  provide: WEB_TOOL_TOKEN,
  useFactory: (configService: ConfigService) => {
    return createBochaWebSearchTool({
      apiKey: configService.get<string>('BOCHA_API_KEY', ''),
      apiUrl: configService.get<string>(
        'BOCHA_API_URL',
        'https://api.bochaai.com/v1/web-search',
      ),
    });
  },
  inject: [ConfigService],
};
