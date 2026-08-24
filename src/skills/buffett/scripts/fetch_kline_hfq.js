#!/usr/bin/env node
/**
 * 拉取 A 股复权 K 线（buffett Step 3 / 回测）。
 *
 * 分工（勿混用）：
 *   - 前复权 forward / fqt=1 → 今日布林、对照盘面（默认）
 *   - 后复权 backward / fqt=2 → 回测、近 N 年收益校准
 *
 * 优先级：
 *   1) opencli eastmoney kline --adjust …
 *   2) browser 直开 push2his URL（显式 fqt）
 *
 * 用法:
 *   node fetch_kline_hfq.js 600900 --period day -o tmp/600900_day_qfq.json
 *   node fetch_kline_hfq.js 600900 --adjust backward --period month --limit 48 -o tmp/600900_month_hfq.json
 *   node fetch_kline_hfq.js 600900 --browser-only
 */

import fs from "node:fs";
import {
  browserFetchJson,
  marketFromCode,
  parseArgs,
  parseJsonText,
  runOpencli,
  secid,
} from "./opencli_json.js";

const PERIOD_MAP = {
  day: ["101", "day", 520],
  week: ["102", "week", 80],
  month: ["103", "month", 40],
};

/** @typedef {"forward"|"backward"} AdjustMode */

const ADJUST = {
  forward: { name: "forward", fqt: 1, label: "前复权" },
  backward: { name: "backward", fqt: 2, label: "后复权" },
};

export function normalizeCodeMarket(raw, market) {
  const s = String(raw).trim().toUpperCase();
  if (s.includes(".")) {
    const [code, mkt] = s.split(".", 2);
    return [code, mkt];
  }
  if (market) return [s, String(market).trim().toUpperCase()];
  return [s, marketFromCode(s)];
}

function resolveAdjust(raw) {
  const key = String(raw || "forward").toLowerCase();
  if (key === "forward" || key === "qfq" || key === "1") return ADJUST.forward;
  if (key === "backward" || key === "hfq" || key === "2") return ADJUST.backward;
  throw new Error(`--adjust 须为 forward|backward（或 qfq|hfq），收到: ${raw}`);
}

function barsFromAdapter(payload) {
  let rows;
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === "object") {
    let found = null;
    for (const key of ["data", "bars", "rows", "items", "kline", "klines"]) {
      if (Array.isArray(payload[key])) {
        found = payload[key];
        break;
      }
    }
    if (!found) throw new Error("adapter 输出无法识别 K 线数组");
    rows = found;
  } else {
    throw new Error("adapter 输出类型错误");
  }

  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const date = row.date || row.trade_date || row.day;
    const close = row.close;
    if (date == null || close == null) continue;
    out.push({
      date: String(date).slice(0, 10),
      open: row.open,
      close: Number(close),
      high: row.high,
      low: row.low,
      volume: row.volume,
    });
  }
  return out;
}

function barsFromPush2his(payload) {
  const data = payload.data || {};
  const klines = data.klines || [];
  const out = [];
  for (const line of klines) {
    const parts = String(line).split(",");
    if (parts.length < 6) continue;
    out.push({
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: parts[5] ? Number(parts[5]) : null,
    });
  }
  return out;
}

export function fetchAdapter(code, period, limit, adjustName) {
  const proc = runOpencli(
    [
      "eastmoney",
      "kline",
      code,
      "--period",
      period,
      "--adjust",
      adjustName,
      "--limit",
      String(limit),
      "-f",
      "json",
    ],
    { timeoutMs: 90_000 },
  );
  if (proc.returncode !== 0) {
    throw new Error((proc.stderr || proc.stdout || "kline adapter failed").slice(0, 400));
  }
  return barsFromAdapter(parseJsonText(proc.stdout || ""));
}

export function fetchBrowser(code, market, { klt, limit, session, fqt }) {
  const sid = secid(code, market);
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    `?secid=${sid}&fields1=f1,f2,f3,f4,f5,f6` +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    `&klt=${klt}&fqt=${fqt}&end=20500101&lmt=${limit}`;
  const payload = browserFetchJson(session, url, { sleepS: 0.8 });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("push2his 返回非对象");
  }
  const bars = barsFromPush2his(payload);
  if (!bars.length) throw new Error("push2his klines 为空");
  return bars;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["code"],
    defaults: { period: "day", session: "buffett-kline", adjust: "forward" },
    booleans: ["browser-only", "browserOnly"],
  });
  if (!args.code) {
    console.error(
      "usage: node fetch_kline_hfq.js <code> [--adjust forward|backward] [--period day|week|month] [-o PATH]",
    );
    return 1;
  }
  if (!PERIOD_MAP[args.period]) {
    console.error("error: --period 须为 day|week|month");
    return 1;
  }

  let adj;
  try {
    adj = resolveAdjust(args.adjust);
  } catch (exc) {
    console.error(String(exc.message || exc));
    return 1;
  }

  const [code, market] = normalizeCodeMarket(args.code, args.market);
  const [klt, periodName, defaultLimit] = PERIOD_MAP[args.period];
  const limit = args.limit != null ? Number(args.limit) : defaultLimit;
  const browserOnly = args.browserOnly || args["browser-only"];

  let source = null;
  let bars = [];
  let errAdapter = null;

  if (!browserOnly) {
    try {
      bars = fetchAdapter(code, periodName, limit, adj.name);
      source = `eastmoney kline --adjust ${adj.name}`;
    } catch (exc) {
      errAdapter = String(exc.message || exc);
    }
  }

  if (!bars.length) {
    try {
      bars = fetchBrowser(code, market, {
        klt,
        limit,
        session: args.session,
        fqt: adj.fqt,
      });
      source = `eastmoney push2his fqt=${adj.fqt} (browser)`;
    } catch (exc) {
      console.error(
        JSON.stringify({ error: String(exc.message || exc), adapter_error: errAdapter }),
      );
      return 1;
    }
  }

  const out = {
    code,
    market,
    secid: secid(code, market),
    period: args.period,
    adjust: adj.name,
    fqt: adj.fqt,
    adjust_label: adj.label,
    source,
    count: bars.length,
    bars,
  };
  const text = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${text}\n`, "utf8");
  else console.log(text);
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
