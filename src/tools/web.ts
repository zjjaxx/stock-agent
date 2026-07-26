import { tool } from '@langchain/core/tools';
import type { DynamicStructuredTool } from '@langchain/core/tools';

interface BochaWebPage {
  name: string;
  url: string;
  summary: string;
  siteName: string;
  siteIcon: string;
  dateLastCrawled: string;
}

interface BochaWebSearchResponse {
  code: number;
  msg?: string;
  data?: {
    webPages: {
      value: BochaWebPage[];
    };
  };
}

interface BochaWebSearchInput {
  query: string;
  count?: number;
}

export interface BochaWebSearchConfig {
  apiKey: string;
  apiUrl: string;
}

async function bochaWebSearch(
  config: BochaWebSearchConfig,
  query: string,
  count = 10,
): Promise<string> {
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      freshness: 'noLimit',
      summary: true,
      count,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `搜索API请求失败，状态码: ${response.status}, 错误信息: ${text}`;
  }

  const jsonResponse = (await response.json()) as BochaWebSearchResponse;

  try {
    if (jsonResponse.code !== 200 || !jsonResponse.data) {
      return `搜索API请求失败，原因是: ${jsonResponse.msg ?? '未知错误'}`;
    }

    const webpages = jsonResponse.data.webPages.value;
    if (!webpages?.length) {
      return '未找到相关结果。';
    }

    return webpages
      .map(
        (page, idx) =>
          `引用: ${idx + 1}\n` +
          `标题: ${page.name}\n` +
          `URL: ${page.url}\n` +
          `摘要: ${page.summary}\n` +
          `网站名称: ${page.siteName}\n` +
          `网站图标: ${page.siteIcon}\n` +
          `发布时间: ${page.dateLastCrawled}\n`,
      )
      .join('\n')
      .trim();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return `搜索API请求失败，原因是：搜索结果解析失败 ${message}`;
  }
}

export function createBochaWebSearchTool(
  config: BochaWebSearchConfig,
): DynamicStructuredTool {
  return tool(
    async ({ query, count }: BochaWebSearchInput) =>
      bochaWebSearch(config, query, count ?? 10),
    {
      name: 'BochaWebSearch',
      description:
        '使用Bocha Web Search API 进行搜索互联网网页，输入应为搜索查询字符串，输出将返回搜索结果的详细信息，包括网页标题、网页URL、网页摘要、网站名称、网站Icon、网页发布时间等。',
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词',
          },
          count: {
            type: 'number',
            description: '返回的搜索结果数量',
            default: 10,
          },
        },
        required: ['query'],
      },
    },
  );
}
