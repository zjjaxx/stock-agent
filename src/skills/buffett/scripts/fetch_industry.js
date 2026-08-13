#!/usr/bin/env node
/**
 * Step1 行业：东财 push2 ulist `f100`（东财行业名），禁止用股票简称猜。
 *
 * 用法:
 *   node fetch_industry.js --pool /tmp/buffett_pool.json -o /tmp/buffett_industry.json
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  browserFetchJson,
  marketFromCode,
  parseArgs,
  parseJsonText,
  readJsonFile,
  secid,
} from "./opencli_json.js";
import { classifyIndustry } from "./industry_map.js";

const ULIST =
  "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1" +
  "&ut=bd1d9ddb04089700cf9c27f6f7426281";

function loadPool(path) {
  const data = readJsonFile(path);
  if (data && typeof data === "object" && Array.isArray(data.pool)) return data.pool;
  if (Array.isArray(data)) return data;
  throw new Error('池文件须为数组，或 {"pool": [...]}');
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function ulistUrl(secids) {
  return `${ULIST}&secids=${secids.join(",")}&fields=f12,f14,f100`;
}

function curlJson(url) {
  const proc = spawnSync("curl", ["-sS", "-A", "Mozilla/5.0", "--max-time", "20", url], {
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error((proc.stderr || "curl failed").slice(0, 200));
  return parseJsonText(proc.stdout || "");
}

function fetchUlist(secids, session) {
  const url = ulistUrl(secids);
  try {
    return curlJson(url);
  } catch (exc) {
    console.log(`ulist curl 失败，改 browser: ${exc.message || exc}`);
    return browserFetchJson(session, url, { sleepS: 0.5 });
  }
}

function diffRows(payload) {
  const diff = payload?.data?.diff;
  return Array.isArray(diff) ? diff : [];
}

export function fetchIndustryForPool(pool, { session = "buffett-industry" } = {}) {
  const items = [];
  for (const row of pool) {
    const code = String(row.code || row.SECURITY_CODE || "").split(".", 2)[0];
    if (!code) continue;
    let market = String(row.market || row.MARKET_SHORT_NAME || "").toUpperCase();
    if (!market) {
      try {
        market = marketFromCode(code);
      } catch {
        market = "";
      }
    }
    items.push({ code, market, name: String(row.name || "") });
  }

  const byCode = {};
  for (const group of chunk(items, 80)) {
    const secids = group.map((r) => secid(r.code, r.market));
    const payload = fetchUlist(secids, session);
    for (const d of diffRows(payload)) {
      const code = String(d.f12 || "");
      const f100 = d.f100 == null || d.f100 === "-" ? "" : String(d.f100);
      const mapped = classifyIndustry({ f100 });
      byCode[code] = {
        code,
        name: d.f14 || "",
        f100,
        source: "eastmoney-ulist-f100",
        ...mapped,
      };
    }
  }

  const rows = items.map((it) => {
    if (byCode[it.code]) return { ...it, ...byCode[it.code] };
    const mapped = classifyIndustry({});
    return {
      ...it,
      f100: "",
      source: "unmapped",
      ...mapped,
    };
  });
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: { session: "buffett-industry" },
  });
  if (!args.pool) {
    console.error("usage: node fetch_industry.js --pool PATH [-o PATH]");
    return 1;
  }
  const pool = loadPool(args.pool);
  const rows = fetchIndustryForPool(pool, { session: args.session });
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, text, "utf8");
  else console.log(text);
  const mapped = rows.filter((r) => !r.unmapped).length;
  console.log(`industry N=${rows.length} mapped=${mapped} unmapped=${rows.length - mapped}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
