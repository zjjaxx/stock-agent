#!/usr/bin/env node
/**
 * 近 5 年估值序列 → TTM 股息率分位 + PB 分位。
 *
 * 注意：buffett skill 已删除「估值分位次路径」。本脚本仅供用户明确要求时的研究参考；
 * `allow_batch` 字段保留兼容，但 Agent 不得据此给建仓/分批/加仓仓位。
 *
 * 数据：
 *   1) RPT_VALUEANALYSIS_DET：日频 CLOSE_PRICE / PB_MRQ（未复权收盘口，配现金分红）
 *   2) RPT_F10_DIVIDEND_MAIN：除权日 + 解析「10派X元」→ 每股现金分红（含「特别」字样的跳过）
 *   3) TTM股息率_t(%) = 过去 365 日现金分红合计 / CLOSE_PRICE_t × 100
 *
 * 用法:
 *   node fetch_valuation_history.js 600900.SH
 *   node fetch_valuation_history.js 600900 --market SH -o ~/Desktop/temp/600900_val.json
 */

import fs from "node:fs";
import {
  browserFetchJson,
  datacenterRows,
  datacenterUrl,
  marketFromCode,
  parseArgs,
  secucode,
} from "./opencli_json.js";

const MS_DAY = 86_400_000;
const YEARS = 5;
const PAGE_SIZE = 1400; // ≈5.5 年交易日

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function toDateStr(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = s.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
  if (m2) {
    return `${m2[1]}-${String(m2[2]).padStart(2, "0")}-${String(m2[3]).padStart(2, "0")}`;
  }
  return null;
}

function parseDpsPerShare(plan) {
  const text = String(plan || "");
  if (!text || text.includes("不分配")) return null;
  // 10派X元 / 每10股派X元
  let m = text.match(/(?:每)?10\s*股?\s*派(?:现金红利|发现金红利|现金)?\s*([\d.]+)\s*元/);
  if (m) return Number(m[1]) / 10;
  m = text.match(/派(?:现金红利|发现金红利|现金)?\s*([\d.]+)\s*元\s*\/\s*股/);
  if (m) return Number(m[1]);
  // 每股派X元
  m = text.match(/每股派(?:现金)?\s*([\d.]+)\s*元/);
  if (m) return Number(m[1]);
  return null;
}

function isSpecialDividend(plan) {
  const t = String(plan || "");
  return t.includes("特别") || t.includes("特殊");
}

function median(arr) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 分位：历史中严格小于当前值的占比 ×100（0=历史最低，100≈历史最高） */
export function percentileRank(series, current) {
  if (current == null || !Number.isFinite(current) || !series?.length) return null;
  const vals = series.filter((x) => x != null && Number.isFinite(x));
  if (!vals.length) return null;
  let below = 0;
  for (const v of vals) {
    if (v < current) below += 1;
  }
  return round((below / vals.length) * 100, 1);
}

function valueAnalysisUrl(code, pageSize = PAGE_SIZE) {
  const filt = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  return (
    "https://datacenter-web.eastmoney.com/api/data/v1/get" +
    "?reportName=RPT_VALUEANALYSIS_DET" +
    "&columns=TRADE_DATE,CLOSE_PRICE,PB_MRQ,PE_TTM" +
    `&filter=${filt}&pageNumber=1&pageSize=${pageSize}` +
    "&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB"
  );
}

function fetchDailyValuation(code, session) {
  const payload = browserFetchJson(session, valueAnalysisUrl(code), { sleepS: 0.75 });
  const rows = datacenterRows(payload);
  const out = [];
  for (const r of rows) {
    const date = toDateStr(r.TRADE_DATE);
    const close = fnum(r.CLOSE_PRICE);
    const pb = fnum(r.PB_MRQ);
    if (!date || close == null || close <= 0) continue;
    out.push({ date, close, pb, pe: fnum(r.PE_TTM) });
  }
  // 升序便于滑窗
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function fetchDividendEvents(sc, session) {
  const url = datacenterUrl("RPT_F10_DIVIDEND_MAIN", sc, {
    pageSize: 100,
    sortColumns: "NOTICE_DATE",
  });
  const payload = browserFetchJson(session, url, { sleepS: 0.65 });
  const rows = datacenterRows(payload);
  const events = [];
  let skippedSpecial = 0;
  for (const r of rows) {
    if (String(r.IS_UNASSIGN) === "1") continue;
    const plan = `${r.IMPL_PLAN_PROFILE || ""}${r.NEW_PROFILE || ""}`;
    if (isSpecialDividend(plan)) {
      skippedSpecial += 1;
      continue;
    }
    const dps = parseDpsPerShare(plan);
    const ex = toDateStr(r.EX_DIVIDEND_DATE);
    if (dps == null || dps <= 0 || !ex) continue;
    events.push({ date: ex, dps, plan: plan.slice(0, 40) });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { events, skippedSpecial };
}

/** 对每个交易日算 TTM 股息率（%） */
function buildYieldSeries(daily, events) {
  if (!daily.length || !events.length) {
    return daily.map((d) => ({ ...d, ttm_dps: 0, div_yield: 0 }));
  }
  let jLo = 0;
  let jHi = 0;
  let windowSum = 0;
  const out = [];
  for (const d of daily) {
    const t = Date.parse(d.date);
    const t0 = t - 365 * MS_DAY;
    while (jHi < events.length && Date.parse(events[jHi].date) <= t) {
      windowSum += events[jHi].dps;
      jHi += 1;
    }
    while (jLo < jHi && Date.parse(events[jLo].date) <= t0) {
      windowSum -= events[jLo].dps;
      jLo += 1;
    }
    const ttm = Math.max(0, windowSum);
    out.push({
      ...d,
      ttm_dps: round(ttm, 4),
      div_yield: round((ttm / d.close) * 100, 4),
    });
  }
  return out;
}

function yearsCovered(daily) {
  if (!daily.length) return 0;
  const a = Date.parse(daily[0].date);
  const b = Date.parse(daily[daily.length - 1].date);
  return round((b - a) / (365.25 * MS_DAY), 2);
}

/**
 * 分位路径是否允许「分批≤5%」：
 * - 有股息率分位 → 仅 ≥80 允许（冲突以股息为准）
 * - 无股息率分位、有 PB → PB ≤20 允许
 */
export function allowValuationBatch({ div_pctile, pb_pctile }) {
  if (div_pctile != null) return div_pctile >= 80;
  if (pb_pctile != null) return pb_pctile <= 20;
  return false;
}

function divZone(pctile) {
  if (pctile == null) return null;
  if (pctile >= 80) return "可少量布局";
  if (pctile > 20 && pctile < 60) return "观望偏中性";
  if (pctile >= 60) return "观望";
  return "偏贵/减仓倾向";
}

function pbZone(pctile) {
  if (pctile == null) return null;
  if (pctile <= 20) return "可少量布局";
  if (pctile < 40) return "观望";
  if (pctile < 80) return "观望偏中性";
  return "偏贵/减仓倾向";
}

export function computeValuationStats(dailyRaw, events, { skippedSpecial = 0 } = {}) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - YEARS);
  const cutStr = cutoff.toISOString().slice(0, 10);
  let daily = dailyRaw.filter((d) => d.date >= cutStr);
  if (daily.length < 60) daily = dailyRaw.slice(); // 不足则用全部并备注

  const withYield = buildYieldSeries(daily, events);
  const last = withYield[withYield.length - 1] || null;
  const yieldSeries = withYield.map((d) => d.div_yield).filter((x) => x != null && x > 0);
  const pbSeries = withYield.map((d) => d.pb).filter((x) => x != null && x > 0);

  const divYieldNow = last?.div_yield ?? null;
  const pbNow = last?.pb ?? null;
  // 分位样本用全序列（含当日）
  const div_pctile = percentileRank(yieldSeries, divYieldNow);
  const pb_pctile = percentileRank(pbSeries, pbNow);

  const yrs = yearsCovered(withYield);
  const allow_batch = allowValuationBatch({ div_pctile, pb_pctile });

  return {
    fetch_ok: Boolean(withYield.length),
    years: yrs,
    years_target: YEARS,
    years_note: yrs < YEARS - 0.25 ? `历史不足${YEARS}年，已用全部可得序列` : null,
    sample_n: withYield.length,
    yield_sample_n: yieldSeries.length,
    pb_sample_n: pbSeries.length,
    asof: last?.date || null,
    close: last?.close ?? null,
    div_yield_now: divYieldNow != null ? round(divYieldNow, 2) : null,
    div_yield_median: yieldSeries.length ? round(median(yieldSeries), 2) : null,
    pb_now: pbNow != null ? round(pbNow, 3) : null,
    div_pctile,
    pb_pctile,
    div_zone: divZone(div_pctile),
    pb_zone: pbZone(pb_pctile),
    allow_batch,
    skipped_special_div: skippedSpecial,
    div_events_n: events.length,
    source: {
      price_pb: "RPT_VALUEANALYSIS_DET (CLOSE_PRICE/PB_MRQ)",
      dividend: "RPT_F10_DIVIDEND_MAIN (除权日+10派X)",
    },
  };
}

export function fetchValuationHistory(code, market, { session = "buffett-valuation" } = {}) {
  const num = String(code).includes(".") ? String(code).split(".", 2)[0] : String(code);
  const mkt = market || marketFromCode(code);
  const sc = secucode(num, mkt);
  try {
    const daily = fetchDailyValuation(num, session);
    const { events, skippedSpecial } = fetchDividendEvents(sc, session);
    const stats = computeValuationStats(daily, events, { skippedSpecial });
    return {
      code: num,
      market: String(mkt).toUpperCase(),
      secucode: sc,
      ...stats,
    };
  } catch (exc) {
    return {
      code: num,
      market: String(mkt).toUpperCase(),
      secucode: sc,
      fetch_ok: false,
      allow_batch: false,
      error: String(exc.message || exc),
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["code"],
    defaults: { session: "buffett-valuation" },
  });
  if (!args.code) {
    console.error("usage: node fetch_valuation_history.js <code> [--market SH] [-o PATH]");
    return 1;
  }
  let market = args.market;
  let code = String(args.code).trim();
  if (code.includes(".")) {
    const [c, m] = code.split(".", 2);
    code = c;
    market = market || m;
  }
  market = market || marketFromCode(code);
  const out = fetchValuationHistory(code, market, { session: args.session });
  const text = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${text}\n`, "utf8");
  else console.log(text);
  return out.fetch_ok === false ? 1 : 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
