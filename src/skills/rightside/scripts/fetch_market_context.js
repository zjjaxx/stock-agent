#!/usr/bin/env node
/**
 * 市场上下文：笑傲牛熊买入条件 1（大盘趋势）与条件 2（行业表现）的数据底座。
 *
 * 温斯坦的顺序是「先大盘、再行业、最后个股」；大盘与行业在本 skill 中均为参考项，不否决买点。
 * 本脚本落盘一份上下文，供 calc_stage.js 判条件 1/2/6（个股相对强度也用这里的指数序列）。
 *
 * 产出 `~/Desktop/temp/rightside_market_context.json`：
 *   market      沪深300 周线趋势（MA30W 位置与斜率）
 *   boards      池内每个东财 f100 行业板块的趋势 + 相对大盘的 Mansfield RS
 *   index_weekly 指数周收盘序列（个股 RS 的分母）
 *
 * 用法:
 *   node fetch_market_context.js --industry ~/Desktop/temp/rightside_industry.json
 *   node fetch_market_context.js --boards 电力,银行 -o ~/Desktop/temp/rightside_market_context.json
 */

import fs from "node:fs";
import {
  browserFetchJson,
  tmpPath,
  httpGetJson,
  parseArgs,
  readJsonFile,
  writeJson,
} from "./opencli_json.js";

import { MA_TYPE, MA_WEEKS, SLOPE_WEEKS, mansfieldRS, sma, toWeeklyBars, trendOf } from "./calc_stage.js";

/** 大盘基准：沪深300。覆盖面比上证综指宽，且不被银行股权重单独绑架。 */
export const MARKET_SECID = "1.000300";
export const MARKET_NAME = "沪深300";

/**
 * push2 / push2his 主域会间歇性拒绝连接（Empty reply from server），
 * push2delay 是同数据的备用域，K 线与板块列表两个接口它都提供（push2hisdelay 只会 302，不可用）。
 */
const KLINE_HOSTS = ["push2his.eastmoney.com", "push2delay.eastmoney.com"];
const LIST_HOSTS = ["push2.eastmoney.com", "push2delay.eastmoney.com"];

const KLINE_PATH = (secid, klt, lmt) =>
  "/api/qt/stock/kline/get" +
  `?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
  "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
  `&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;

/** 板块列表单页上限 100 条，东财约 500 个行业板块，必须翻页。 */
const BOARD_PAGE_SIZE = 100;
const BOARD_LIST_PATH = (pn) =>
  "/api/qt/clist/get" +
  `?pn=${pn}&pz=${BOARD_PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14`;

/** 与 fetch_kline_hfq.js 共用同一个浏览器 session，避免重复开窗。 */
const BROWSER_SESSION = "rightside-kline";

/**
 * 东财对密集请求会返回 Empty reply / 空 klines，换域名也没用（整个 IP 被短暂拒绝）。
 * 先退避重试两轮 HTTP，仍失败就退回浏览器直开 URL——和本 skill 其它抓数脚本一致。
 */
async function getWithHostFallback(hosts, pathAndQuery, { isEmpty = () => false } = {}) {
  const errors = [];
  for (let round = 0; round < 2; round++) {
    if (round) sleep(3000);
    for (const host of hosts) {
      try {
        const payload = await httpGetJson(`https://${host}${pathAndQuery}`, { retries: 1 });
        if (isEmpty(payload)) {
          errors.push(`${host}: 返回空数据（限流）`);
          continue;
        }
        return payload;
      } catch (exc) {
        errors.push(`${host}: ${String(exc.message || exc).slice(0, 100)}`);
      }
    }
  }
  try {
    const payload = browserFetchJson(BROWSER_SESSION, `https://${hosts[0]}${pathAndQuery}`);
    if (!isEmpty(payload)) return payload;
    errors.push("browser: 返回空数据");
  } catch (exc) {
    errors.push(`browser: ${String(exc.message || exc).slice(0, 100)}`);
  }
  throw new Error(errors.slice(-3).join(" | "));
}

function barsFromKlines(payload) {
  const klines = payload?.data?.klines || [];
  const out = [];
  for (const line of klines) {
    const p = String(line).split(",");
    if (p.length < 6) continue;
    out.push({
      date: p[0],
      open: Number(p[1]),
      close: Number(p[2]),
      high: Number(p[3]),
      low: Number(p[4]),
      volume: p[5] ? Number(p[5]) : null,
    });
  }
  return out;
}

/** 日线拉回来再按 ISO 周聚合，保证与个股周线用同一套周键（RS 对齐的前提）。 */
async function fetchWeekly(secid, { lmt = 1300 } = {}) {
  const payload = await getWithHostFallback(KLINE_HOSTS, KLINE_PATH(secid, 101, lmt), {
    isEmpty: (p) => !(p?.data?.klines || []).length,
  });
  const bars = barsFromKlines(payload);
  if (!bars.length) throw new Error(`${secid} 日线为空`);
  return {
    name: payload?.data?.name || secid,
    weekly: toWeeklyBars(bars, null),
  };
}

/** 东财行业板块名 → BK 代码。f100 与板块名一一对应（如「电力」→ BK0428）。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 板块名→BK 代码。约 500 条且很少变动，落盘复用；连续翻页会被东财限流，故每页间隔。
 */
export async function fetchBoardMap({ cachePath = tmpPath("em_boards.json"), refresh = false } = {}) {
  if (!refresh && fs.existsSync(cachePath)) {
    try {
      const cached = readJsonFile(cachePath);
      if (cached?.boards && Object.keys(cached.boards).length > 300) {
        return new Map(Object.entries(cached.boards));
      }
    } catch {
      /* 缓存损坏则重拉 */
    }
  }
  const map = new Map();
  let total = Infinity;
  for (let pn = 1; (pn - 1) * BOARD_PAGE_SIZE < total && pn <= 12; pn++) {
    if (pn > 1) sleep(600);
    const payload = await getWithHostFallback(LIST_HOSTS, BOARD_LIST_PATH(pn), {
      isEmpty: (p) => {
        const d = p?.data?.diff;
        return !d || (Array.isArray(d) ? d.length === 0 : Object.keys(d).length === 0);
      },
    });
    total = Number(payload?.data?.total) || map.size;
    const diff = payload?.data?.diff || {};
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    if (!rows.length) break;
    for (const r of rows) {
      if (r?.f12 && r?.f14) map.set(String(r.f14), String(r.f12));
    }
  }
  if (map.size < 300) throw new Error(`行业板块列表只取到 ${map.size} 条（预期约 500），疑似被限流`);
  writeJson(cachePath, { fetched_at: new Date().toISOString(), boards: Object.fromEntries(map) });
  return map;
}

/** 板块名容错：f100 可能带 Ⅱ/Ⅲ 后缀，或是二级行业的简写。 */
function resolveBoardCode(name, boardMap) {
  if (!name) return null;
  const raw = String(name).trim();
  const candidates = [raw, raw.replace(/[ⅠⅡⅢⅣ]/g, ""), `${raw}Ⅱ`, `${raw}Ⅲ`];
  for (const c of candidates) {
    if (boardMap.has(c)) return boardMap.get(c);
  }
  for (const [k, v] of boardMap) {
    if (k.replace(/[ⅠⅡⅢⅣ]/g, "") === raw) return v;
  }
  return null;
}

function boardsFromArgs(args) {
  if (args.boards) {
    return [...new Set(String(args.boards).split(",").map((s) => s.trim()).filter(Boolean))];
  }
  if (args.industry && fs.existsSync(args.industry)) {
    const payload = readJsonFile(args.industry);
    const rows = Array.isArray(payload) ? payload : payload.rows || payload.industry || [];
    return [...new Set(rows.map((r) => r.f100).filter(Boolean))];
  }
  return [];
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      industry: tmpPath("rightside_industry.json"),
      output: tmpPath("rightside_market_context.json"),
    },
  });

  const maType = String(args.maType || args["ma-type"] || MA_TYPE).toLowerCase();
  const market = await fetchWeekly(MARKET_SECID);
  const marketTrend = trendOf(market.weekly, { maType });
  if (!marketTrend.ok) throw new Error(`大盘趋势不可判：${marketTrend.error}`);
  const indexCloses = market.weekly.map((r) => r.close);

  const names = boardsFromArgs(args);
  const boards = {};
  let boardMap = new Map();
  if (names.length) {
    // 板块名映射拿不到就直接失败：静默降级会让条件2 全池「未知」，等于悄悄放弃行业过滤
    boardMap = await fetchBoardMap({ refresh: Boolean(args.refreshBoards || args["refresh-boards"]) });
  }

  for (const name of names) {
    if (boards[name]) continue;
    const bk = resolveBoardCode(name, boardMap);
    if (!bk) {
      boards[name] = { ok: false, error: `东财板块列表无「${name}」，行业条件无法判定` };
      continue;
    }
    try {
      sleep(250);
      const b = await fetchWeekly(`90.${bk}`, { lmt: 1300 });
      const trend = trendOf(b.weekly, { maType });
      const rs = mansfieldRS(b.weekly, market.weekly);
      boards[name] = {
        ok: trend.ok,
        board_code: bk,
        board_name: b.name,
        weeks: b.weekly.length,
        as_of: b.weekly.at(-1)?.date || null,
        ...trend,
        rs_vs_market: rs,
        // 行业「表现不错」= 站上 30 周均线且均线不向下；跑赢大盘（RS>0）再加一分
        pass: Boolean(trend.ok && trend.above_ma && trend.slope_pct >= 0),
        outperform: Boolean(rs?.ok && rs.value > 0),
      };
    } catch (exc) {
      boards[name] = { ok: false, board_code: bk, error: String(exc.message || exc).slice(0, 200) };
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    as_of: market.weekly.at(-1)?.date || null,
    source: "eastmoney push2his klt=101 → ISO 周聚合",
    ma_weeks: MA_WEEKS,
    ma_type: maType,
    slope_weeks: SLOPE_WEEKS,
    market: {
      name: MARKET_NAME,
      secid: MARKET_SECID,
      weeks: market.weekly.length,
      ...marketTrend,
      // 大盘「趋势向好」= 站上 30 周均线且均线向上
      pass: Boolean(marketTrend.above_ma && marketTrend.slope_pct > 0),
    },
    boards,
    index_weekly: market.weekly.map((r) => ({ date: r.date, close: r.close })),
  };
  writeJson(args.output, out);

  const m = out.market;
  console.log(
    `MARKET ${MARKET_NAME} ${m.close} vs MA30W ${m.ma30w}（${m.dev_pct >= 0 ? "+" : ""}${m.dev_pct}%）` +
      ` 斜率 ${m.slope_pct}% → ${m.pass ? "趋势向好 ✓" : "趋势不佳 ✗"}`,
  );
  for (const [name, b] of Object.entries(boards)) {
    console.log(
      b.ok
        ? `BOARD ${name}(${b.board_code}) ${b.pass ? "✓" : "✗"} dev ${b.dev_pct}% slope ${b.slope_pct}%` +
            ` RS ${b.rs_vs_market?.value ?? "—"}`
        : `BOARD ${name} ✗ ${b.error}`,
    );
  }
  console.log(`CONTEXT=${args.output}`);
  return 0;
}

export { fetchWeekly, resolveBoardCode, sma };

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (exc) => {
      console.error(JSON.stringify({ error: String(exc.message || exc) }));
      process.exit(1);
    },
  );
}
