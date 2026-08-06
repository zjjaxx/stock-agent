import { Module } from '@nestjs/common';
import { WebToolProvider } from './web.provider.js';
import { TimeToolProvider } from './time.provider.js';

@Module({
  providers: [WebToolProvider, TimeToolProvider],
  exports: [WebToolProvider, TimeToolProvider],
})
export class ToolsModule {}
