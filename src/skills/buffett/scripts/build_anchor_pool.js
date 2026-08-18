#!/usr/bin/env node
/**
 * 构建长期锚校准样本池：按东财 f100 行业取总市值靠前公司。
 *
 * 东财 clist 的 pz 上限是 100；pz=5000 会被静默截成一页 100 只。必须按 pn 翻页。
 *
 * 用法:
 *   node build_anchor_pool.js -o ~/Desktop/temp/buffett_anchor_pool.json
 *   node build_anchor_pool.js --per-industry 25 --min-market-cap-yi 200 -o ...
 *   node build_anchor_pool.js --self-test
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeIndustry } from "./anchor_config.js";
import { browserFetchJson, httpGetJson, parseArgs } from "./opencli_json.js";

export const PAGE_SIZE = 100;
const MAX_PAGES = 80;
const CLIST_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const CLIST_FIELDS = "f12,f13,f14,f20,f100";
const CLIST_UT = "bd1d9ddb04089700cf9c27f6f7426281";
export const CLIST_HOSTS = [
  "push2delay.eastmoney.com",
  "push2.eastmoney.com",
  "82.push2.eastmoney.com",
  "88.push2.eastmoney.com",
];

export function clistUrl(page, pageSize = PAGE_SIZE, host = CLIST_HOSTS[0]) {
  return (
    `https://${host}/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1` +
    `&fltt=2&invt=2&fid=f20&ut=${CLIST_UT}&fs=${CLIST_FS}&fields=${CLIST_FIELDS}`
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function asRows(diff) {
  if (Array.isArray(diff)) return diff;
  if (diff && typeof diff === "object") return Object.values(diff);
  return [];
}

async function fetchPage(session, page, host, useBrowser) {
  const url = clistUrl(page, PAGE_SIZE, host);
  if (useBrowser) return browserFetchJson(session, url, { sleepS: 1 });
  return httpGetJson(url);
}

async function fetchPageWithFallback(session, page, host, useBrowser) {
  if (useBrowser) return { payload: await fetchPage(session, page, host, true), host, useBrowser: true };
  const hosts = [host, ...CLIST_HOSTS.filter((h) => h !== host)];
  const errors = [];
  for (const candidate of hosts) {
    try {
      const payload = await fetchPage(session, page, candidate, false);
      if (candidate !== host) console.log(`clist 改用 ${candidate}`);
      return { payload, host: candidate, useBrowser: false };
    } catch (exc) {
      errors.push(`${candidate}: ${exc.message || exc}`);
    }
  }
  console.log(`clist http 全部失败，改 browser: ${errors[0] || "unknown"}`);
  const payload = await fetchPage(session, page, host, true);
  return { payload, host, useBrowser: true };
}

export async function fetchUniverse(session) {
  let host = CLIST_HOSTS[0];
  let useBrowser = false;
  const seen = new Set();
  const all = [];
  let total = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await fetchPageWithFallback(session, page, host, useBrowser);
    host = got.host;
    useBrowser = got.useBrowser;
    const payload = got.payload;

    const rows = asRows(payload?.data?.diff);
    const reported = Number(payload?.data?.total);
    if (Number.isFinite(reported) && reported > 0) total = reported;
    if (!rows.length) break;

    const before = all.length;
    for (const row of rows) {
      const code = String(row.f12 || "");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      all.push(row);
    }
    console.log(
      `clist page ${page}: +${rows.length} unique=${all.length}` +
        ` total=${total == null ? "?" : total} via=${useBrowser ? "browser" : host}`,
    );
    if (all.length === before) {
      console.log(`clist 第${page}页无新增，停止翻页`);
      break;
    }
    if (total != null && all.length >= total) break;
    if (rows.length < PAGE_SIZE) break;
    sleep(80);
  }

  if (!all.length) throw new Error("clist 未返回任何股票");
  if (total != null && total > PAGE_SIZE && all.length <= PAGE_SIZE) {
    throw new Error(`clist 翻页失败：接口 total=${total} 但只拿到 ${all.length} 只`);
  }
  return { data: { diff: all, total: total ?? all.length } };
}

function marketOf(row) {
  if (Number(row.f13) === 1) return "SH";
  if (String(row.f12).startsWith("8") || String(row.f12).startsWith("4")) return "BJ";
  return "SZ";
}

export function buildAnchorPool(
  diff,
  { perIndustry = 20, minMarketCapYi = 200 } = {},
) {
  const minCap = Number(minMarketCapYi) * 1e8;
  const groups = new Map();
  for (const row of diff || []) {
    const code = String(row.f12 || "");
    const name = String(row.f14 || "");
    const f100 = normalizeIndustry(row.f100);
    const marketCap = Number(row.f20);
    if (!/^\d{6}$/.test(code) || !f100 || !Number.isFinite(marketCap) || marketCap < minCap) continue;
    if (/退|ST/i.test(name)) continue;
    const item = {
      code,
      market: marketOf(row),
      name,
      f100,
      market_cap_yi: Number((marketCap / 1e8).toFixed(2)),
    };
    if (!groups.has(f100)) groups.set(f100, []);
    groups.get(f100).push(item);
  }

  const pool = [];
  const groupStats = [];
  for (const [f100, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))) {
    rows.sort((a, b) => b.market_cap_yi - a.market_cap_yi);
    const selected = rows.slice(0, Number(perIndustry));
    pool.push(...selected);
    groupStats.push({
      f100,
      eligible: rows.length,
      selected: selected.length,
    });
  }
  return { pool, groups: groupStats };
}

export function selfTest() {
  const fails = [];
  const page1 = clistUrl(1);
  if (!page1.includes("pz=100") || page1.includes("pz=5000")) fails.push("clist-pz-100");
  if (!clistUrl(2).includes("pn=2")) fails.push("clist-pn-2");
  if (!page1.includes("push2delay.eastmoney.com")) fails.push("clist-default-delay-host");
  if (asRows({ 0: { f12: "1" }, 1: { f12: "2" } }).length !== 2) fails.push("asRows-object");

  const rows = [
    { f12: "600519", f13: 1, f14: "贵州茅台", f100: "白酒Ⅱ", f20: 16000e8 },
    { f12: "000858", f13: 0, f14: "五粮液", f100: "白酒", f20: 2800e8 },
    { f12: "000568", f13: 0, f14: "泸州老窖", f100: "白酒Ⅰ", f20: 1500e8 },
    { f12: "600809", f13: 1, f14: "山西汾酒", f100: "白酒", f20: 2200e8 },
    { f12: "002304", f13: 0, f14: "洋河股份", f100: "白酒", f20: 1100e8 },
    { f12: "000596", f13: 0, f14: "古井贡酒", f100: "白酒", f20: 900e8 },
    { f12: "603589", f13: 1, f14: "口子窖", f100: "白酒", f20: 250e8 },
    { f12: "000799", f13: 0, f14: "酒鬼酒", f100: "白酒", f20: 180e8 },
    { f12: "000333", f13: 0, f14: "美的集团", f100: "白色家电", f20: 6300e8 },
    { f12: "000651", f13: 0, f14: "格力电器", f100: "白色家电", f20: 2200e8 },
    { f12: "600690", f13: 1, f14: "海尔智家", f100: "白色家电", f20: 2000e8 },
    { f12: "000921", f13: 0, f14: "海信家电", f100: "白色家电", f20: 450e8 },
    { f12: "600000", f13: 1, f14: "*ST示例", f100: "白酒", f20: 500e8 },
  ];
  const result = buildAnchorPool(rows);
  const baijiu = result.groups.find((g) => g.f100 === "白酒");
  const appliance = result.groups.find((g) => g.f100 === "白色家电");
  if (!baijiu || baijiu.eligible < 7) fails.push(`baijiu-eligible ${JSON.stringify(baijiu)}`);
  if (result.pool.some((x) => x.code === "000799")) fails.push("below-200yi-kept");
  if (result.pool.some((x) => /\*ST/.test(x.name))) fails.push("st-kept");
  if (!appliance || appliance.eligible !== 4) fails.push(`appliance-eligible ${JSON.stringify(appliance)}`);
  return fails;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      session: "buffett-anchor-pool",
      "per-industry": "20",
      "min-market-cap-yi": "200",
    },
    booleans: ["selfTest", "self-test"],
  });
  if (args.selfTest || args["self-test"]) {
    const fails = selfTest();
    if (fails.length) {
      console.error(`self-test FAIL ${fails.length}`);
      for (const fail of fails) console.error(`  ${fail}`);
      return 1;
    }
    console.log("self-test OK");
    return 0;
  }
  const perIndustry = Number(args.perIndustry);
  const minMarketCapYi = Number(args.minMarketCapYi);
  if (!Number.isInteger(perIndustry) || perIndustry < 1 || !Number.isFinite(minMarketCapYi)) {
    throw new Error("--per-industry 须为正整数，--min-market-cap-yi 须为数字");
  }
  const payload = await fetchUniverse(args.session);
  const result = buildAnchorPool(payload?.data?.diff, { perIndustry, minMarketCapYi });
  const output = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    source: "eastmoney-clist-f20-f100",
    selection: { per_industry: perIndustry, min_market_cap_yi: minMarketCapYi },
    universe: { n: payload?.data?.diff?.length ?? 0, total: payload?.data?.total ?? null },
    ...result,
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, text, "utf8");
  } else {
    console.log(text);
  }
  const baijiu = result.groups.find((g) => g.f100 === "白酒");
  console.log(`anchor pool N=${result.pool.length}, f100=${result.groups.length}`);
  if (baijiu) console.log(`白酒 eligible=${baijiu.eligible} selected=${baijiu.selected}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
