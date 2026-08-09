#!/usr/bin/env node
/**
 * 抓取中国 10 年期国债收益率（buffett Step 1 股息/国债比）。
 *
 * 用法:
 *   node fetch_bond_yield.js
 *   node fetch_bond_yield.js -o /tmp/bond.json
 */

import fs from "node:fs";
import {
  browserEval,
  browserOpen,
  browserWaitText,
  parseArgs,
} from "./opencli_json.js";

const DEFAULT_URL = "https://cn.investing.com/rates-bonds/china-10-year-bond-yield";

function parseYield(text) {
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

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      url: DEFAULT_URL,
      session: "buffett-bond",
      timeoutMs: "25000",
    },
  });
  const timeoutMs = Number(args.timeoutMs || args["timeout-ms"] || 25000);

  let raw;
  try {
    browserOpen(args.session, args.url);
    browserWaitText(args.session, "%", { timeoutMs });
    raw = browserEval(
      args.session,
      '(function(){return (document.body.innerText||"").slice(0,5000);})()',
    );
  } catch (exc) {
    console.error(JSON.stringify({ error: String(exc.message || exc) }));
    return 1;
  }

  const yld = parseYield(raw);
  if (yld == null) {
    console.error(
      JSON.stringify({ error: "未能从页面解析收益率", snippet: raw.slice(0, 500) }),
    );
    return 1;
  }

  const out = {
    yield_pct: yld,
    source: "Investing.com 中国10Y 国债收益率",
    url: args.url,
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
  // prefer local timezone ISO
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  out.fetched_at = `${local}${sign}${oh}:${om}`;

  const textOut = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${textOut}\n`, "utf8");
  else console.log(textOut);
  return 0;
}

process.exit(main());
