#!/usr/bin/env node
/**
 * 日线 → 周/月重采样 → 布林带，并映射到每个交易日（防前视：只用已收盘周/月）。
 *
 *   node calc_bollinger.js ~/Desktop/temp/dca_hs300_day.json
 *   node calc_bollinger.js ~/Desktop/temp/dca_hldf_day.json --period 20 --mult 2
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs, readJsonFile, writeJson } from "./opencli_json.js";

const DEFAULT_PERIOD = 20;
const DEFAULT_MULT = 2;

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function stdSample(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  let s = 0;
  for (const x of arr) s += (x - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

/** ISO 周键：YYYY-Www（周一为一周开始） */
function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

/** 按键聚合：取该键最后一根日 K 作为该周/月 OHLC（开=首开，高/低=极值，收=末收） */
function resample(bars, keyFn) {
  const map = new Map();
  for (const b of bars) {
    const k = keyFn(b.date);
    let g = map.get(k);
    if (!g) {
      g = {
        key: k,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      };
      map.set(k, g);
    } else {
      g.date = b.date;
      g.high = Math.max(g.high, b.high);
      g.low = Math.min(g.low, b.low);
      g.close = b.close;
      g.volume = (g.volume || 0) + (b.volume || 0);
    }
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function bollinger(series, period, mult) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    if (i + 1 < period) {
      out.push({
        date: series[i].date,
        key: series[i].key,
        close: series[i].close,
        mid: null,
        upper: null,
        lower: null,
        ok: false,
      });
      continue;
    }
    const window = series.slice(i + 1 - period, i + 1).map((x) => x.close);
    const mid = mean(window);
    const sd = stdSample(window);
    const upper = mid + mult * sd;
    const lower = mid - mult * sd;
    out.push({
      date: series[i].date,
      key: series[i].key,
      close: series[i].close,
      mid,
      upper,
      lower,
      sd,
      ok: true,
    });
  }
  return out;
}

/**
 * 每个交易日 → 上一根已收盘周/月的布林。
 * 当日若仍处在该周/月内，则用「再上一根」已收盘 bar（严格防前视）。
 */
function mapDailySignals(dayBars, weekBoll, monthBoll) {
  const weekByKey = new Map(weekBoll.map((b) => [b.key, b]));
  const monthByKey = new Map(monthBoll.map((b) => [b.key, b]));
  const weekKeys = weekBoll.map((b) => b.key);
  const monthKeys = monthBoll.map((b) => b.key);

  function prevCompleted(keys, currentKey) {
    const idx = keys.indexOf(currentKey);
    if (idx <= 0) return null;
    return keys[idx - 1];
  }

  return dayBars.map((d) => {
    const wk = isoWeekKey(d.date);
    const mk = monthKey(d.date);
    const prevW = prevCompleted(weekKeys, wk);
    const prevM = prevCompleted(monthKeys, mk);
    const wb = prevW ? weekByKey.get(prevW) : null;
    const mb = prevM ? monthByKey.get(prevM) : null;
    return {
      date: d.date,
      close: d.close,
      week_key: wk,
      month_key: mk,
      week_mid: wb?.ok ? wb.mid : null,
      week_upper: wb?.ok ? wb.upper : null,
      week_lower: wb?.ok ? wb.lower : null,
      month_mid: mb?.ok ? mb.mid : null,
      month_upper: mb?.ok ? mb.upper : null,
      month_lower: mb?.ok ? mb.lower : null,
      signal_buy: wb?.ok ? d.close < wb.mid : false,
      signal_sell_band: mb?.ok ? d.close > mb.upper : false,
    };
  });
}

export function computeBollinger(dayPayload, { period = DEFAULT_PERIOD, mult = DEFAULT_MULT } = {}) {
  const bars = dayPayload.bars || [];
  if (bars.length < period + 5) {
    throw new Error(`日线过短: ${bars.length}`);
  }
  const weekly = resample(bars, isoWeekKey);
  const monthly = resample(bars, monthKey);
  const weekBoll = bollinger(weekly, period, mult);
  const monthBoll = bollinger(monthly, period, mult);
  const daily = mapDailySignals(bars, weekBoll, monthBoll);
  const ready = daily.filter((d) => d.week_mid != null && d.month_upper != null);
  return {
    key: dayPayload.key || null,
    name: dayPayload.name || null,
    code: dayPayload.code || null,
    secid: dayPayload.secid || null,
    period,
    mult,
    source_file: dayPayload._path || null,
    day_count: bars.length,
    week_count: weekly.length,
    month_count: monthly.length,
    signal_ready_from: ready[0]?.date || null,
    signal_ready_to: ready.at(-1)?.date || null,
    weekly: weekBoll,
    monthly: monthBoll,
    daily,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["input"],
    defaults: { period: String(DEFAULT_PERIOD), mult: String(DEFAULT_MULT) },
  });
  if (!args.input) {
    console.error("usage: node calc_bollinger.js <day.json> [--period 20] [--mult 2] [-o out.json]");
    return 1;
  }
  const input = path.resolve(args.input);
  const payload = readJsonFile(input);
  payload._path = input;
  const period = Number(args.period) || DEFAULT_PERIOD;
  const mult = Number(args.mult) || DEFAULT_MULT;
  const result = computeBollinger(payload, { period, mult });
  delete payload._path;

  const outPath =
    args.output ||
    input.replace(/\.json$/i, "_boll.json") ||
    `${input}_boll.json`;
  writeJson(outPath, result);
  console.log(
    JSON.stringify(
      {
        output: outPath,
        key: result.key,
        name: result.name,
        week_count: result.week_count,
        month_count: result.month_count,
        signal_ready_from: result.signal_ready_from,
        signal_ready_to: result.signal_ready_to,
      },
      null,
      2,
    ),
  );
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main() ?? 0);
}
