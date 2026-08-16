#!/usr/bin/env node
/**
 * 用后复权收盘价计算布林带（供 buffett Step 3）。
 *
 * 默认参数与 SKILL.md 一致：
 *   - 日线/周线：20 期，2 倍标准差
 *   - 月线：24 期，2 倍标准差
 *
 * 用法:
 *   node calc_bollinger.js tmp/k.json
 *   node fetch_kline_hfq.js 600900 --browser-only -o tmp/k.json && node calc_bollinger.js tmp/k.json
 *   node calc_bollinger.js tmp/k.json --period D --window 20 --nbdev 2
 */

import fs from "node:fs";
import { parseArgs } from "./opencli_json.js";

const DEFAULTS = {
  D: { window: 20, nbdev: 2.0 },
  W: { window: 20, nbdev: 2.0 },
  M: { window: 24, nbdev: 2.0 },
};

function loadPayload(path) {
  const text = path ? fs.readFileSync(path, "utf8") : fs.readFileSync(0, "utf8");
  return JSON.parse(text);
}

function normalizeDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

function toBars(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["bars", "data", "rows", "items", "kline", "klines"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  throw new Error("输入 JSON 须为 K 线数组，或含 bars/data/rows[]（东财 kline --adjust backward）");
}

/** ISO 周键 YYYY-Www */
function isoWeekKey(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  // Thursday in current week decides the year
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  const isoYear = date.getUTCFullYear();
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

/** period: D|W|M。周/月取该周期最后一个交易日的后复权收盘价。 */
function resampleCloses(bars, period) {
  const daily = [];
  for (const row of bars) {
    const date = normalizeDate(row.trade_date || row.date || row.day);
    const close = row.close;
    if (!date || close == null) continue;
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    daily.push([date, c]);
  }
  daily.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  if (period === "D") return daily;

  const buckets = new Map();
  for (const [date, close] of daily) {
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(4, 6));
    const d = Number(date.slice(6, 8));
    const key = period === "M" ? `${String(y).padStart(4, "0")}${String(m).padStart(2, "0")}` : isoWeekKey(y, m, d);
    const prev = buckets.get(key);
    if (!prev || date >= prev[0]) buckets.set(key, [date, close]);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

function bollinger(series, window, nbdev) {
  if (series.length < window) {
    return {
      ok: false,
      error: `有效样本 ${series.length} < window=${window}，无法计算布林带`,
      count: series.length,
    };
  }
  const closes = series.map(([, c]) => c);
  const windowCloses = closes.slice(-window);
  const mean = windowCloses.reduce((a, b) => a + b, 0) / window;
  const variance = windowCloses.reduce((a, x) => a + (x - mean) ** 2, 0) / window;
  const std = Math.sqrt(variance);
  const upper = mean + nbdev * std;
  const lower = mean - nbdev * std;
  const [lastDate, lastClose] = series[series.length - 1];
  const bandwidth = mean ? (upper - lower) / mean : null;

  return {
    ok: true,
    as_of: lastDate,
    close: round(lastClose, 4),
    mid: round(mean, 4),
    upper: round(upper, 4),
    lower: round(lower, 4),
    bandwidth: bandwidth == null ? null : round(bandwidth, 6),
    bandwidth_pct: bandwidth == null ? null : round(bandwidth * 100, 2),
    window,
    nbdev,
    sample_count: series.length,
  };
}

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["input"],
    defaults: { period: "all" },
  });

  let payload;
  let bars;
  try {
    payload = loadPayload(args.input);
    bars = toBars(payload);
  } catch (exc) {
    console.error(JSON.stringify({ error: String(exc.message || exc) }));
    return 1;
  }

  const meta = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const periods = args.period === "all" ? ["D", "W", "M"] : [args.period];
  if (!["D", "W", "M", "all"].includes(args.period)) {
    console.error(JSON.stringify({ error: `--period 须为 D|W|M|all，收到 ${args.period}` }));
    return 1;
  }

  const result = {
    ts_code: meta.ts_code || meta.symbol || null,
    adj: meta.adj || "backward",
    bands: {},
  };

  for (const p of periods) {
    const defaults = DEFAULTS[p];
    const window = args.window != null ? Number(args.window) : defaults.window;
    const nbdev = args.nbdev != null ? Number(args.nbdev) : defaults.nbdev;
    const series = resampleCloses(bars, p);
    result.bands[p] = { period: p, ...bollinger(series, window, nbdev) };
  }

  console.log(JSON.stringify(result, null, 2));
  return 0;
}

process.exit(main());
