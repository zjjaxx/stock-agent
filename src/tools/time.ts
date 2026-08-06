import { tool } from '@langchain/core/tools';
import type { DynamicStructuredTool } from '@langchain/core/tools';

interface GetCurrentTimeInput {
  timezone?: string;
}

function formatCurrentTime(timezone = 'Asia/Shanghai'): string {
  const now = new Date();

  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    });

    return JSON.stringify({
      iso: now.toISOString(),
      timezone,
      formatted: formatter.format(now),
      timestamp: now.getTime(),
    });
  } catch {
    return JSON.stringify({
      error: `无效的时区: ${timezone}`,
      hint: '请使用 IANA 时区名称，例如 Asia/Shanghai、America/New_York、UTC',
    });
  }
}

export function createGetCurrentTimeTool(): DynamicStructuredTool {
  return tool(
    ({ timezone }: GetCurrentTimeInput) =>
      formatCurrentTime(timezone ?? 'Asia/Shanghai'),
    {
      name: 'GetCurrentTime',
      description:
        '获取当前时间。默认返回中国时区（Asia/Shanghai）的日期和时间，可用于判断交易日、开盘收盘时间等。可选传入 IANA 时区名称。',
      schema: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              'IANA 时区名称，例如 Asia/Shanghai、America/New_York、UTC。默认 Asia/Shanghai',
            default: 'Asia/Shanghai',
          },
        },
        required: [],
      },
    },
  );
}
