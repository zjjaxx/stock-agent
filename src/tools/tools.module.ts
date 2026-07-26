import { Module } from '@nestjs/common';
import { WebToolProvider } from './web.provider.js';

@Module({
  providers: [WebToolProvider],
  exports: [WebToolProvider],
})
export class ToolsModule {}
