#!/usr/bin/env node
/**
 * Step1 行业标注：东财 push2 ulist `f100`（东财行业名），禁止用股票简称猜。
 *
 * 右侧交易没有基本面硬筛，本步只做两件事：给全池挂上 f100，并把带 f100 的池落成
 * Step2 的输入（--pass-json）。f100 缺失不剔除，条件2 标「未知（参考）」不拦买点。
 *
 * 用法:
 *   node fetch_industry.js --pool ~/Desktop/temp/rightside_pool.json \
 *     -o ~/Desktop/temp/rightside_industry.json \
 *     --pass-json ~/Desktop/temp/rightside_pass_pool.json
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { normalizeIndustry } from "./industry_map.js";
import {
  browserFetchJson,
  marketFromCode,
  parseArgs,
  parseJsonText,
  readJsonFile,
  secid,
} from "./opencli_json.js";

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

export function fetchIndustryForPool(pool, { session = "rightside-industry" } = {}) {
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
      const raw = d.f100 == null || d.f100 === "-" ? "" : String(d.f100);
      const f100 = normalizeIndustry(raw);
      byCode[code] = {
        code,
        name: d.f14 || "",
        f100,
        f100_raw: raw,
        source: "eastmoney-ulist-f100",
      };
    }
  }

  return items.map((it) => {
    if (byCode[it.code]) return { ...it, ...byCode[it.code] };
    return {
      ...it,
      f100: "",
      f100_raw: "",
      source: "missing",
    };
  });
}

/** 池行 + f100 合并成 Step2 的输入；ulist 只回 f12/f14/f100，市值等字段仍取池行。 */
function mergePool(pool, rows) {
  const byCode = {};
  for (const r of rows) byCode[String(r.code)] = r;
  return pool
    .map((row) => {
      const code = String(row.code || "").split(".", 2)[0];
      const hit = byCode[code];
      if (!hit) return null;
      return {
        code,
        name: row.name || hit.name || "",
        market: row.market || hit.market || null,
        mkt_yi: row.mkt_yi ?? null,
        price: row.price ?? null,
        f100: hit.f100,
        f100_raw: hit.f100_raw,
        industry_source: hit.source,
      };
    })
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: { session: "rightside-industry" },
  });
  if (!args.pool) {
    console.error(
      "usage: node fetch_industry.js --pool PATH [-o PATH] [--pass-json PATH]",
    );
    return 1;
  }
  const pool = loadPool(args.pool);
  const rows = fetchIndustryForPool(pool, { session: args.session });
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, text, "utf8");
  else console.log(text);

  const passJson = args.passJson || args["pass-json"];
  if (passJson) {
    const merged = mergePool(pool, rows);
    fs.writeFileSync(passJson, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`PASS_POOL=${passJson} M=${merged.length}`);
  }

  const withF100 = rows.filter((r) => r.f100).length;
  console.log(`industry N=${rows.length} with_f100=${withF100} missing=${rows.length - withF100}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
