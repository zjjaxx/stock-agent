#!/usr/bin/env node
/**
 * 择时定投 vs 无脑定投回测引擎。
 *
 * 策略 A（择时）：收盘 < 已收盘周布林中轨 → 买 500；市值>底仓且收盘>已收盘月布林上轨 → 卖 1/5
 * 策略 B（无脑）：每日买 500，不卖
 *
 *   node run_backtest.js
 *   node run_backtest.js --capital 200000 --daily 500 --floor 100000 --window-years 3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeBollinger } from "./calc_bollinger.js";
import { parseArgs, readJsonFile, tmpPath, writeJson } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  capital: 200_000,
  daily: 500,
  floor: 100_000,
  windowYears: 3,
  bollPeriod: 20,
  bollMult: 2,
};

function addYears(dateStr, years) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const ms = new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`);
  return ms / 86400000;
}

function maxDrawdown(equityCurve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function cagr(startValue, endValue, startDate, endDate) {
  const years = daysBetween(startDate, endDate) / 365.25;
  if (years <= 0 || startValue <= 0 || endValue <= 0) return null;
  return (endValue / startValue) ** (1 / years) - 1;
}

/**
 * @param {"timed"|"blind"} mode
 */
function simulate(daily, { mode, capital, dailyAmt, floor, startDate, endDate }) {
  const bars = daily.filter((d) => d.date >= startDate && d.date <= endDate);
  if (bars.length < 20) {
    return { ok: false, error: `窗口内交易日过少: ${bars.length}` };
  }

  let cash = capital;
  let shares = 0;
  let grossBuy = 0; // 累计买入额（含卖出回笼后再买，≠本金）
  let grossSell = 0;
  let buyCount = 0;
  let sellCount = 0;
  let buySkippedNoCash = 0;
  let buySkippedNoSignal = 0;
  let sellSkippedFloor = 0;
  let peakDeployed = 0; // 峰值占用资金 = capital - cash（本金里最多有多少在仓）
  const equity = [];
  const first = bars[0];
  const last = bars.at(-1);

  for (const d of bars) {
    const price = d.close;
    if (!(price > 0)) continue;

    const wantBuy =
      mode === "blind" ? true : Boolean(d.signal_buy && d.week_mid != null);
    if (mode === "timed" && !d.signal_buy) buySkippedNoSignal += 1;

    if (wantBuy) {
      const spend = Math.min(dailyAmt, cash);
      if (spend >= 1) {
        const qty = spend / price;
        shares += qty;
        cash -= spend;
        grossBuy += spend;
        buyCount += 1;
      } else {
        buySkippedNoCash += 1;
      }
    }

    const posValue = shares * price;
    if (mode === "timed" && d.signal_sell_band && d.month_upper != null) {
      if (posValue > floor && shares > 0) {
        const sellQty = shares / 5;
        const proceeds = sellQty * price;
        shares -= sellQty;
        cash += proceeds;
        grossSell += proceeds;
        sellCount += 1;
      } else if (posValue > 0) {
        sellSkippedFloor += 1;
      }
    }

    // 现金不得为负；NAV = 现金 + 持仓
    if (cash < -1e-6) {
      return { ok: false, error: `现金为负 ${cash} @ ${d.date}` };
    }
    const nav = cash + shares * price;
    equity.push(nav);
    peakDeployed = Math.max(peakDeployed, capital - Math.min(cash, capital));
  }

  const endPrice = last.close;
  const endPos = shares * endPrice;
  const endNav = cash + endPos;
  // 收益相对初始本金（外加资金始终 = capital，卖出只是内部调仓）
  const totalReturn = (endNav - capital) / capital;
  const bhShares = capital / first.close;
  const bhEnd = bhShares * endPrice;
  const bhReturn = (bhEnd - capital) / capital;

  return {
    ok: true,
    mode,
    start: first.date,
    end: last.date,
    trading_days: bars.length,
    capital,
    daily_amount: dailyAmt,
    floor,
    // 本金固定；gross_* 仅作周转参考，不作「投入本金」
    gross_buy: round2(grossBuy),
    gross_sell: round2(grossSell),
    peak_deployed: round2(peakDeployed),
    cash_end: round2(cash),
    shares_end: shares,
    position_end: round2(endPos),
    nav_end: round2(endNav),
    profit: round2(endNav - capital),
    return_pct: round4(totalReturn),
    cagr: round4(cagr(capital, endNav, first.date, last.date)),
    max_drawdown: round4(maxDrawdown(equity)),
    buy_count: buyCount,
    sell_count: sellCount,
    buy_skipped_no_cash: buySkippedNoCash,
    buy_skipped_no_signal: buySkippedNoSignal,
    sell_skipped_floor: sellSkippedFloor,
    buy_hold_return_pct: round4(bhReturn),
    excess_vs_bh_pct: round4(totalReturn - bhReturn),
    first_close: first.close,
    last_close: endPrice,
    bh_label: labelRegime(bhReturn),
  };
}

/** 窗内买入持有：>15% 牛，<-15% 熊，其余震荡 */
function labelRegime(bhReturn) {
  if (bhReturn >= 0.15) return "牛市";
  if (bhReturn <= -0.15) return "熊市";
  return "震荡";
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.round(x * 10000) / 10000;
}

function buildWindows(readyFrom, readyTo, windowYears) {
  const windows = [];
  let start = readyFrom;
  while (true) {
    const end = addYears(start, windowYears);
    if (end > readyTo) break;
    // 实际结束取窗口末日或数据末日之前最近交易日——回测时再 filter
    windows.push({
      label: `${start.slice(0, 4)}~${end.slice(0, 4)}`,
      start,
      end_exclusive: end,
      end: addYears(end, 0), // placeholder; simulate uses <= endDate
    });
    // end_exclusive 作为 endDate 的开区间上界：用 end-1day 近似 → 用 end 前一天字符串
    const d = new Date(`${end}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    windows.at(-1).end = d.toISOString().slice(0, 10);
    start = end;
  }
  return windows;
}

function loadSymbol(dayPath) {
  const day = readJsonFile(dayPath);
  const bollPath = dayPath.replace(/\.json$/i, "_boll.json");
  let boll;
  if (fs.existsSync(bollPath)) {
    boll = readJsonFile(bollPath);
  } else {
    boll = computeBollinger(day, { period: DEFAULTS.bollPeriod, mult: DEFAULTS.bollMult });
    writeJson(bollPath, boll);
  }
  return { day, boll, dayPath, bollPath };
}

function summarizeRegime(runs) {
  const groups = { 牛市: [], 熊市: [], 震荡: [] };
  for (const r of runs) {
    if (!r.ok) continue;
    const g = groups[r.bh_label] || (groups[r.bh_label] = []);
    g.push(r);
  }
  const out = {};
  for (const [label, arr] of Object.entries(groups)) {
    if (!arr.length) {
      out[label] = { n: 0 };
      continue;
    }
    const avg = (key) => arr.reduce((s, x) => s + (x[key] || 0), 0) / arr.length;
    out[label] = {
      n: arr.length,
      avg_return_pct: round4(avg("return_pct")),
      avg_cagr: round4(avg("cagr")),
      avg_max_drawdown: round4(avg("max_drawdown")),
      avg_excess_vs_bh_pct: round4(avg("excess_vs_bh_pct")),
    };
  }
  return out;
}

function pairTimedVsBlind(timedRuns, blindRuns) {
  const byLabel = new Map(blindRuns.filter((r) => r.ok).map((r) => [r.window_label || "full", r]));
  return timedRuns
    .filter((r) => r.ok)
    .map((t) => {
      const b = byLabel.get(t.window_label || "full");
      if (!b) return null;
      return {
        window_label: t.window_label || "full",
        regime: t.bh_label,
        timed_return_pct: t.return_pct,
        blind_return_pct: b.return_pct,
        timed_dd: t.max_drawdown,
        blind_dd: b.max_drawdown,
        timed_nav: t.nav_end,
        blind_nav: b.nav_end,
      };
    })
    .filter(Boolean);
}

export function runBacktest({
  symbols,
  capital = DEFAULTS.capital,
  dailyAmt = DEFAULTS.daily,
  floor = DEFAULTS.floor,
  windowYears = DEFAULTS.windowYears,
} = {}) {
  const results = {
    params: {
      capital,
      daily: dailyAmt,
      floor,
      window_years: windowYears,
      boll_period: DEFAULTS.bollPeriod,
      boll_mult: DEFAULTS.bollMult,
      buy_rule: "close < prior completed week BB mid",
      sell_rule: "position_value > floor AND close > prior completed month BB upper → sell 1/5",
      blind_rule: "buy daily_amount every session until cash runs out; never sell",
      regime_rule: "buy&hold return ≥15% 牛 / ≤−15% 熊 / else 震荡",
    },
    as_of: new Date().toISOString(),
    symbols: [],
  };

  for (const sym of symbols) {
    const { day, boll, dayPath, bollPath } = loadSymbol(sym.path);
    const daily = boll.daily;
    const readyFrom = boll.signal_ready_from;
    const readyTo = boll.signal_ready_to;
    if (!readyFrom || !readyTo) {
      results.symbols.push({
        key: day.key,
        name: day.name,
        error: "布林信号未就绪",
      });
      continue;
    }

    const windows = buildWindows(readyFrom, readyTo, windowYears);
    const timedFull = simulate(daily, {
      mode: "timed",
      capital,
      dailyAmt,
      floor,
      startDate: readyFrom,
      endDate: readyTo,
    });
    const blindFull = simulate(daily, {
      mode: "blind",
      capital,
      dailyAmt,
      floor,
      startDate: readyFrom,
      endDate: readyTo,
    });
    timedFull.window_label = "full";
    blindFull.window_label = "full";

    const timedWindows = [];
    const blindWindows = [];
    for (const w of windows) {
      const t = simulate(daily, {
        mode: "timed",
        capital,
        dailyAmt,
        floor,
        startDate: w.start,
        endDate: w.end,
      });
      const b = simulate(daily, {
        mode: "blind",
        capital,
        dailyAmt,
        floor,
        startDate: w.start,
        endDate: w.end,
      });
      t.window_label = w.label;
      b.window_label = w.label;
      timedWindows.push(t);
      blindWindows.push(b);
    }

    const comparisons = pairTimedVsBlind(
      [timedFull, ...timedWindows],
      [blindFull, ...blindWindows],
    );

    results.symbols.push({
      key: day.key || path.basename(dayPath),
      name: day.name,
      code: day.code,
      secid: day.secid,
      adjust: day.adjust,
      day_file: dayPath,
      boll_file: bollPath,
      data_range: { first: day.first || day.bars?.[0]?.date, last: day.last || day.bars?.at(-1)?.date },
      signal_range: { from: readyFrom, to: readyTo },
      full: { timed: timedFull, blind: blindFull },
      windows: windows.map((w, i) => ({
        label: w.label,
        start: w.start,
        end: w.end,
        timed: timedWindows[i],
        blind: blindWindows[i],
        comparison: comparisons.find((c) => c.window_label === w.label) || null,
      })),
      comparisons,
      regime_summary: {
        timed: summarizeRegime(timedWindows),
        blind: summarizeRegime(blindWindows),
      },
    });
  }

  // 重叠区间：两标的信号都就绪后的共同全样本，便于横比
  if (results.symbols.length >= 2 && results.symbols.every((s) => s.signal_range)) {
    const commonFrom = results.symbols
      .map((s) => s.signal_range.from)
      .sort()
      .at(-1);
    const commonTo = results.symbols
      .map((s) => s.signal_range.to)
      .sort()[0];
    if (commonFrom && commonTo && commonFrom < commonTo) {
      const common = { from: commonFrom, to: commonTo, symbols: [] };
      for (const sym of symbols) {
        const { day, boll } = loadSymbol(sym.path);
        const timed = simulate(boll.daily, {
          mode: "timed",
          capital,
          dailyAmt,
          floor,
          startDate: commonFrom,
          endDate: commonTo,
        });
        const blind = simulate(boll.daily, {
          mode: "blind",
          capital,
          dailyAmt,
          floor,
          startDate: commonFrom,
          endDate: commonTo,
        });
        timed.window_label = "common";
        blind.window_label = "common";
        common.symbols.push({
          key: day.key || sym.key,
          name: day.name,
          timed,
          blind,
        });
      }
      results.common_period = common;
    }
  }

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      capital: String(DEFAULTS.capital),
      daily: String(DEFAULTS.daily),
      floor: String(DEFAULTS.floor),
      "window-years": String(DEFAULTS.windowYears),
      hs300: tmpPath("dca_hs300_day.json"),
      hldf: tmpPath("dca_hldf_day.json"),
      zzhl: tmpPath("dca_zzhl_day.json"),
      output: tmpPath("dca_backtest_result.json"),
    },
  });

  const symbols = [];
  for (const [key, flag] of [
    ["hs300", args.hs300],
    ["hldf", args.hldf],
    ["zzhl", args.zzhl],
  ]) {
    if (flag && fs.existsSync(flag)) symbols.push({ key, path: flag });
  }
  // 可选指数对照
  const idxPath = tmpPath("dca_hldf_idx_day.json");
  if (fs.existsSync(idxPath) && args["include-idx"]) {
    symbols.push({ key: "hldf_idx", path: idxPath });
  }

  if (!symbols.length) {
    console.error("缺少日线文件，请先跑 fetch_dca_universe.js");
    return 1;
  }

  const result = runBacktest({
    symbols,
    capital: Number(args.capital),
    dailyAmt: Number(args.daily),
    floor: Number(args.floor),
    windowYears: Number(args["window-years"] || args.windowYears),
  });

  writeJson(args.output, result);
  console.log(
    JSON.stringify(
      {
        output: args.output,
        symbols: result.symbols.map((s) => ({
          key: s.key,
          name: s.name,
          full_timed_return: s.full?.timed?.return_pct,
          full_blind_return: s.full?.blind?.return_pct,
          windows: s.windows?.length,
        })),
      },
      null,
      2,
    ),
  );
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c ?? 0));
}
