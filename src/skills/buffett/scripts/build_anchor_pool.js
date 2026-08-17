#!/usr/bin/env node
/**
 * 构建长期锚校准样本池：按东财 f100 行业取总市值靠前公司。
 *
 * 用法:
 *   node build_anchor_pool.js -o ~/Desktop/temp/buffett_anchor_pool.json
 *   node build_anchor_pool.js --per-industry 25 --min-market-cap-yi 200 -o ...
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeIndustry } from "./anchor_config.js";
import { browserFetchJson, parseArgs, parseJsonText } from "./opencli_json.js";

const CLIST =
  "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5000&po=1&np=1" +
  "&fltt=2&invt=2&fid=f20&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23" +
  "&fields=f12,f13,f14,f20,f100";

function curlJson(url) {
  const proc = spawnSync("curl", ["-sS", "-A", "Mozilla/5.0", "--max-time", "30", url], {
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error((proc.stderr || "curl failed").slice(0, 300));
  return parseJsonText(proc.stdout || "");
}

function fetchUniverse(session) {
  try {
    return curlJson(CLIST);
  } catch (exc) {
    console.log(`clist curl 失败，改 browser: ${exc.message || exc}`);
    return browserFetchJson(session, CLIST, { sleepS: 1 });
  }
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

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      session: "buffett-anchor-pool",
      "per-industry": "20",
      "min-market-cap-yi": "200",
    },
  });
  const perIndustry = Number(args.perIndustry);
  const minMarketCapYi = Number(args.minMarketCapYi);
  if (!Number.isInteger(perIndustry) || perIndustry < 1 || !Number.isFinite(minMarketCapYi)) {
    throw new Error("--per-industry 须为正整数，--min-market-cap-yi 须为数字");
  }
  const payload = fetchUniverse(args.session);
  const result = buildAnchorPool(payload?.data?.diff, { perIndustry, minMarketCapYi });
  const output = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    source: "eastmoney-clist-f20-f100",
    selection: { per_industry: perIndustry, min_market_cap_yi: minMarketCapYi },
    ...result,
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, text, "utf8");
  } else {
    console.log(text);
  }
  console.log(`anchor pool N=${result.pool.length}, f100=${result.groups.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
