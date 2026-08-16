#!/usr/bin/env node
/**
 * 抓取中国 10 年期国债收益率（buffett Step 0 股息下限 = 国债×2）。
 *
 * 用法:
 *   node fetch_bond_yield.js
 *   node fetch_bond_yield.js -o tmp/bond.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserEval,
  browserOpen,
  browserWaitText,
  parseArgs,
} from "./opencli_json.js";

const DEFAULT_URL = "https://cn.investing.com/rates-bonds/china-10-year-bond-yield";

export function parseYield(text) {
  const candidates = [];
  const re =
    /(?:中国十年期国债|China\s*10|10\s*[- ]?Year)[^\n]{0,80}?(\d\.\d{2,4})\s*%?/gi;
  let m;
  while ((m = re.exec(text))) candidates.push(Number(m[1]));
  if (candidates.length) return candidates[0];

  const head = text.slice(0, 2500);
  const re2 = /\b([1-5]\.\d{2,4})\b/g;
  while ((m = re2.exec(head))) {
    const v = Number(m[1]);
    if (v >= 1.0 && v <= 6.0) candidates.push(v);
  }
  return candidates.length ? candidates[0] : null;
}

function localFetchedAt() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${oh}:${om}`;
}

export function fetchBondYield({
  session = "buffett-bond",
  url = DEFAULT_URL,
  timeoutMs = 25000,
} = {}) {
  browserOpen(session, url);
  browserWaitText(session, "%", { timeoutMs });
  const raw = browserEval(
    session,
    '(function(){return (document.body.innerText||"").slice(0,5000);})()',
  );
  const yld = parseYield(raw);
  if (yld == null) {
    throw new Error(`未能从页面解析收益率: ${raw.slice(0, 200)}`);
  }
  return {
    yield_pct: yld,
    source: "Investing.com 中国10Y 国债收益率",
    url,
    fetched_at: localFetchedAt(),
  };
}

/** Step 0 东财自定义股息下限：国债×2，最多两位小数并去掉尾零（1.75→3.5）。 */
export function step0DivFloor(bondPct) {
  const bond = Number(bondPct);
  if (!Number.isFinite(bond) || bond <= 0) {
    throw new Error(`无效国债收益率: ${bondPct}`);
  }
  const exact = bond * 2;
  const lo = Number(exact.toFixed(2));
  return { bond, exact, lo, loStr: String(lo) };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      url: DEFAULT_URL,
      session: "buffett-bond",
      timeoutMs: "25000",
    },
  });
  const timeoutMs = Number(args.timeoutMs || args["timeout-ms"] || 25000);

  let out;
  try {
    out = fetchBondYield({
      session: args.session,
      url: args.url,
      timeoutMs,
    });
  } catch (exc) {
    console.error(JSON.stringify({ error: String(exc.message || exc) }));
    return 1;
  }

  const textOut = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${textOut}\n`, "utf8");
  else console.log(textOut);
  return 0;
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
