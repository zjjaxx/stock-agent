import { Provider } from '@nestjs/common';
import { createGetCurrentTimeTool } from './time.js';

export const TIME_TOOL_TOKEN = 'timeTool';
export const TimeToolProvider: Provider = {
  provide: TIME_TOOL_TOKEN,
  useFactory: () => createGetCurrentTimeTool(),
};
