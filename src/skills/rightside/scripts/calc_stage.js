#!/usr/bin/env node
/**
 * 笑傲牛熊（Stan Weinstein）技术位：六条件买入清单。
 *
 * 顺序是温斯坦原书的顺序——先大盘、再行业、最后个股：
 *   1 大盘趋势向好（**参考项**：只提示逆势风险，不否决买点）
 *   2 所属行业表现不错（**参考项**：只提示逆行业风险，不否决买点）
 *   3 向上突破阻力区 + 站上 30 周均线，且上方阻力相比之下最小
 *      （突破必须建立在阶段1 底座上：长期下跌后停止创新低、低位横盘、均线由跌转平）
 *   4 突破周量能 ≥ 过去几个月平均周量的 2 倍（或近 3–4 周合计 ≥ 同跨度均量 2 倍，且突破周本身必须放大）
 *   5 回撤到 30 周均线附近且回调明显缩量（第二买点；前置突破也必须是阶段1→2）
 *   6 相对强度（股价/大盘指数）在零轴之上，或由负转正；负值且形态差 → 禁止买入
 *
 * 买点只有两个：条件 6 通过后，满足 3+4 是「突破买点」，满足 5 是「回踩买点」。
 * 条件 1、2 不参与放行：大盘/行业不好时买点照给，但结论里必须带逆势/逆行业提示。
 * 阶段2 中途的新高/回踩不算——没有阶段1 底座的突破一律否决。
 *
 * 输入：日线（优先，重采样成周线，历史更长）或周线前复权 K 线 JSON（fetch_kline_hfq.js --adjust forward）。
 * 市场上下文：fetch_market_context.js 产出的 rightside_market_context.json（缺失则条件 1/2/6 判为未知，不给买点）。
 *
 * 用法:
 *   node calc_stage.js ~/Desktop/temp/600900_day_qfq.json
 *   node calc_stage.js ~/Desktop/temp/600900_day_qfq.json --context ~/Desktop/temp/rightside_market_context.json --industry 电力
 *   node calc_stage.js ~/Desktop/temp/600900_day_qfq.json --ma-type sma   # 切回简单均线做对照
 */

import fs from "node:fs";
import { tmpPath, parseArgs } from "./opencli_json.js";

/** 30 周均线：温斯坦阶段划分与买点的唯一主均线。 */
export const MA_WEEKS = 30;
/**
 * 均线类型。原书第 13 页讲原理时用简单平均举例，但第 25 页说明：他实际看的 Mansfield 图表
 * 「并非每周等权重的简单均线，而是加权 30 周均线，离当前越近权重越高」，书中全部案例图都是这种。
 * 故默认 wma（线性递增权重，最近一周权重 30、最远一周权重 1）；`--ma-type sma` 可切回简单均线做对照。
 */
export const MA_TYPE = "wma";
/** 斜率观察窗（周）与走平阈值（相对 MA 百分比）。 */
export const SLOPE_WEEKS = 5;
export const SLOPE_FLAT_PCT = 1.0;
/** 阻力区（盘整平台）窗口。 */
export const BASE_WEEKS = 30;
/** 「过去几个月」的平均周成交量口径：26 周 ≈ 半年。 */
export const VOLUME_WINDOW = 26;
/** 条件4：突破周量能倍数门槛（温斯坦要求至少 2 倍，越高越好）。 */
export const VOLUME_SURGE = 2.0;
/** 条件4 备选口径：近 3–4 周合计量 vs 同跨度平均量的倍数，且突破周本身必须放大。 */
export const VOLUME_MULTI_WEEKS = 4;
export const VOLUME_MULTI_SURGE = 2.0;
export const BREAKOUT_WEEK_MIN_RATIO = 1.2;
/** 突破的新鲜度：超过 8 周的突破不再算「刚突破」。 */
export const BREAKOUT_MAX_WEEKS = 8;
/** 突破买点允许的追高上限：距 30 周均线不超过该幅度。 */
export const ENTRY_MAX_DEV_PCT = 12;
/** 条件5 回踩区间：均线上方 5% 以内，轻微跌破 3% 仍算回踩。 */
export const PULLBACK_DEV_PCT = 5;
export const PULLBACK_UNDERCUT_PCT = -3;
/** 条件5 回调缩量门槛：量比 ≤ 该值才算「成交量明显萎缩」。 */
export const PULLBACK_VOL_MAX = 0.8;
/** 回踩买点要求趋势已经存在（前 26 周均线涨幅），否则贴均线只是盘整横摆。 */
export const PRIOR_TREND_WEEKS = 26;
export const TREND_MATURE_PCT = 3;
/**
 * 条件5 的前置突破：回踩买的是「一次已完成的放量突破」的第二次机会，不是任意一根贴均线的缩量周。
 * 均线滞后于股价，阶段2 翻头进阶段3/4 的头几周同样是「均线仍向上 + 缩量跌向均线」，
 * 只靠 TREND_MATURE_PCT 区分不开；故要求回踩之前确有一次放量突破。
 * 窗口比条件3 的 BREAKOUT_MAX_WEEKS 长得多：突破后走一段再回抽到 30 周均线，本就可能隔几十周。
 */
export const PULLBACK_BREAKOUT_LOOKBACK = 52;
/** 前置突破的量能门槛与条件4 同为 2 倍：阶段1→2 突破本身不够放量，后面的回踩也不算第二买点。 */
export const PULLBACK_BREAKOUT_VOL_MIN = 2.0;
/**
 * 阶段1 底座（突破前置）：温斯坦突破买点必须从「长期下跌 → 停止创新低 → 低位横盘 →
 * 均线由跌转平」走出来，再向上突破阻力区并站上 MA30W。
 * 用突破**前一周**的均线状态判定（避免突破周本身把均线抬歪）；
 * prior26 过大说明已是成熟阶段2，那种「中途新高」不算底部突破。
 */
export const BASE_PRIOR_MAX_PCT = 8;
export const BASE_PRIOR_MIN_PCT = -30;
export const BASE_SLOPE_MIN_PCT = -1.5;
export const BASE_SLOPE_MAX_PCT = 3.0;
/** 底座后半段低点 ≥ 前半段低点 × 该系数 → 停止创新低。 */
export const BASE_LOW_TOLERANCE = 0.97;
/** 更早下跌确认：突破前 52→26 周均线至少跌过该幅度，或 prior26 本身为负。 */
export const BASE_DECLINE_LOOKBACK = 52;
export const BASE_DECLINE_MIN_PCT = 5;
/** 条件3「上方阻力最小」：近 104 周里高于现价的周数占比 ≤ 该值。 */
export const OVERHEAD_WEEKS = 104;
export const OVERHEAD_MAX_PCT = 20;
/** 条件6 Mansfield 相对强度：比值除以自身 52 周均值。 */
export const RS_WEEKS = 52;
/** 由负转正的观察窗，以及判「形态差」的斜率窗。 */
export const RS_CROSS_WEEKS = 8;
export const RS_SLOPE_WEEKS = 4;

export const STAGE_PLAYBOOK = {
  1: {
    label: "阶段1 · 底部盘整（吸筹）",
    strategy:
      "只观察不建仓：等 30 周均线由平转升、且放量突破盘整区上沿（条件3+4）再动手。列入观察清单，标注阻力区上沿作为触发价。",
  },
  2: {
    label: "阶段2 · 上升（可操作）",
    strategy:
      "唯一可建仓阶段：条件6 通过后，按突破买点（3+4）或回踩买点（5）入场（条件1/2 大盘与行业仅作参考提示）。持股期间以「周收盘跌破 30 周均线且均线转平/走弱」为离场信号。",
  },
  3: {
    label: "阶段3 · 顶部派发",
    strategy:
      "禁止新建仓：均线走平、股价高位反复，属派发区。持仓者应逐步了结；等待方向明确（重回阶段2 或转入阶段4）。",
  },
  4: {
    label: "阶段4 · 下跌（回避）",
    strategy:
      "严禁抄底：股价在下行 30 周均线之下，反弹到均线附近只是解套盘。清仓离场、持币等待新的阶段1 筑底完成。",
  },
};

function round(n, digits = 2) {
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function pct(n) {
  const v = round(n);
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`;
}

function loadPayload(p) {
  const text = p ? fs.readFileSync(p, "utf8") : fs.readFileSync(0, "utf8");
  return JSON.parse(text);
}

function toBars(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["bars", "data", "rows", "items", "kline", "klines"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  throw new Error("输入 JSON 须为 K 线数组，或含 bars/data/rows[]（东财 kline --adjust forward）");
}

function normalizeDate(raw) {
  if (raw == null) return null;
  const digits = String(raw).trim().replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

/** ISO 周键 YYYY-Www；个股与指数按同一周键对齐，相对强度才不会错位。 */
export function isoWeekKey(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function weekKeyOf(date) {
  return isoWeekKey(Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8)));
}

/**
 * 归一成周 bar：{ date, week, close, high, low, volume }。
 * 日线按 ISO 周聚合（收盘取周内最后一日，量取周内合计）；周线原样。
 */
export function toWeeklyBars(bars, periodHint) {
  const rows = [];
  for (const row of bars) {
    const date = normalizeDate(row.date || row.trade_date || row.day);
    const close = Number(row.close);
    if (!date || !Number.isFinite(close)) continue;
    rows.push({
      date,
      close,
      high: Number.isFinite(Number(row.high)) ? Number(row.high) : close,
      low: Number.isFinite(Number(row.low)) ? Number(row.low) : close,
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (periodHint === "week") return rows.map((r) => ({ ...r, week: weekKeyOf(r.date) }));

  const buckets = new Map();
  for (const r of rows) {
    const key = weekKeyOf(r.date);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ...r, week: key });
      continue;
    }
    cur.high = Math.max(cur.high, r.high);
    cur.low = Math.min(cur.low, r.low);
    if (r.volume != null) cur.volume = (cur.volume ?? 0) + r.volume;
    if (r.date >= cur.date) {
      cur.date = r.date;
      cur.close = r.close;
    }
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

export function sma(values, window, endIdx) {
  if (endIdx == null || endIdx + 1 < window || endIdx >= values.length) return null;
  let sum = 0;
  for (let i = endIdx - window + 1; i <= endIdx; i++) sum += values[i];
  return sum / window;
}

/** 线性加权：最近一期权重 = window，最远一期权重 = 1（Mansfield 图表口径）。 */
export function wma(values, window, endIdx) {
  if (endIdx == null || endIdx + 1 < window || endIdx >= values.length) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i < window; i++) {
    const w = window - i;
    num += values[endIdx - i] * w;
    den += w;
  }
  return num / den;
}

export function movingAvg(values, window, endIdx, type = MA_TYPE) {
  return type === "sma" ? sma(values, window, endIdx) : wma(values, window, endIdx);
}

/** 30 周均线位置与斜率——大盘、行业、个股共用同一把尺子。 */
export function trendOf(weekly, { maType = MA_TYPE } = {}) {
  if (!weekly || weekly.length < MA_WEEKS + SLOPE_WEEKS + 1) {
    return { ok: false, error: `周 bar ${weekly?.length ?? 0} 根 < ${MA_WEEKS + SLOPE_WEEKS + 1}` };
  }
  const closes = weekly.map((r) => r.close);
  const last = closes.length - 1;
  const ma = movingAvg(closes, MA_WEEKS, last, maType);
  const maPrev = movingAvg(closes, MA_WEEKS, last - SLOPE_WEEKS, maType);
  const maPrior = movingAvg(closes, MA_WEEKS, Math.max(MA_WEEKS - 1, last - PRIOR_TREND_WEEKS), maType);
  const close = closes[last];
  const devPct = ((close - ma) / ma) * 100;
  const slopePct = ((ma - maPrev) / maPrev) * 100;
  const priorPct = ((ma - maPrior) / maPrior) * 100;
  return {
    ok: true,
    as_of: weekly[last].date,
    ma_type: maType,
    close: round(close, 4),
    ma30w: round(ma, 4),
    dev_pct: round(devPct),
    slope_pct: round(slopePct),
    prior_pct: round(priorPct),
    above_ma: close >= ma,
    slope_word: slopePct > SLOPE_FLAT_PCT ? "向上" : slopePct < -SLOPE_FLAT_PCT ? "向下" : "走平",
  };
}

/**
 * Mansfield 相对强度：RS = 收盘 / 指数收盘，再除以自身 52 周均值减 1。
 * 零轴之上 = 跑赢大盘；由负转正 = 资金开始相对流入；负值且还在往下 = 形态差，禁买。
 */
export function mansfieldRS(weekly, indexWeekly) {
  if (!weekly?.length || !indexWeekly?.length) {
    return { ok: false, error: "缺指数序列，相对强度无法计算" };
  }
  const idx = new Map();
  for (const r of indexWeekly) {
    const key = r.week || weekKeyOf(normalizeDate(r.date) || String(r.date).replace(/\D/g, ""));
    if (key) idx.set(key, Number(r.close));
  }
  const ratios = [];
  for (const r of weekly) {
    const key = r.week || weekKeyOf(r.date);
    const iv = idx.get(key);
    if (Number.isFinite(iv) && iv > 0) ratios.push({ date: r.date, v: r.close / iv });
  }
  if (ratios.length < RS_WEEKS + RS_CROSS_WEEKS) {
    return { ok: false, error: `可对齐周数 ${ratios.length} < ${RS_WEEKS + RS_CROSS_WEEKS}` };
  }
  const vals = ratios.map((r) => r.v);
  const series = [];
  for (let i = RS_WEEKS - 1; i < vals.length; i++) {
    // Mansfield RS 的 52 周基准按原定义用简单平均，不随主均线的加权口径变化
    const avg = sma(vals, RS_WEEKS, i);
    series.push({ date: ratios[i].date, mrs: (vals[i] / avg - 1) * 100 });
  }
  const last = series.at(-1);
  const window = series.slice(-RS_CROSS_WEEKS);
  const prevSlope = series.at(-1 - RS_SLOPE_WEEKS)?.mrs;
  const rising = prevSlope != null && last.mrs > prevSlope;
  const turnedPositive = last.mrs > 0 && window.slice(0, -1).some((p) => p.mrs < 0);
  return {
    ok: true,
    as_of: last.date,
    value: round(last.mrs),
    positive: last.mrs > 0,
    turned_positive: turnedPositive,
    rising,
    // 负值且还在往下 = 温斯坦所说的「形态很差」，此时禁止买入
    shape_poor: last.mrs < 0 && !rising,
    weeks: series.length,
  };
}

function classifyStage({ devPct, slopePct, priorPct, ddFromHighPct }) {
  const rising = slopePct > SLOPE_FLAT_PCT;
  const falling = slopePct < -SLOPE_FLAT_PCT;
  if (rising && devPct > PULLBACK_UNDERCUT_PCT) return 2;
  if (falling && devPct < 0) return 4;
  if (priorPct > 5 && ddFromHighPct > -25) return 3;
  if (priorPct < -5 || ddFromHighPct <= -25) return 1;
  return devPct >= 0 ? 3 : 1;
}

/**
 * 突破周是否建立在阶段1 底座上。
 * 在突破前一周量均线：须由跌转平/刚转升、前 26 周涨幅不大、底座内停止创新低、更早确有下跌。
 * @returns {{ ok: boolean, reason: string, slope_pct: number|null, prior_pct: number|null, stopped_lower_lows: boolean|null, had_decline: boolean|null }}
 */
export function assessStage1Base(weekly, breakoutIdx, { maType = MA_TYPE } = {}) {
  const need = MA_WEEKS + BASE_DECLINE_LOOKBACK + 1;
  if (!weekly || breakoutIdx == null || breakoutIdx < need) {
    return {
      ok: false,
      reason: `历史不足（突破周索引 ${breakoutIdx}，至少需 ${need} 根周 bar）`,
      slope_pct: null,
      prior_pct: null,
      stopped_lower_lows: null,
      had_decline: null,
    };
  }
  // 看突破前一周的底座状态，避开突破周本身对加权均线的瞬间抬升
  const j = breakoutIdx - 1;
  const closes = weekly.map((r) => r.close);
  const ma = movingAvg(closes, MA_WEEKS, j, maType);
  const maPrev = movingAvg(closes, MA_WEEKS, j - SLOPE_WEEKS, maType);
  const maPrior26 = movingAvg(closes, MA_WEEKS, j - PRIOR_TREND_WEEKS, maType);
  const maPrior52 = movingAvg(closes, MA_WEEKS, j - BASE_DECLINE_LOOKBACK, maType);
  if (![ma, maPrev, maPrior26].every(Number.isFinite)) {
    return {
      ok: false,
      reason: "突破前均线序列不完整",
      slope_pct: null,
      prior_pct: null,
      stopped_lower_lows: null,
      had_decline: null,
    };
  }
  const slopePct = ((ma - maPrev) / maPrev) * 100;
  const priorPct = ((ma - maPrior26) / maPrior26) * 100;
  const declinePct =
    Number.isFinite(maPrior52) && maPrior52 > 0 ? ((maPrior26 - maPrior52) / maPrior52) * 100 : null;
  const hadDecline = (declinePct != null && declinePct <= -BASE_DECLINE_MIN_PCT) || priorPct < 0;

  const baseBars = weekly.slice(Math.max(0, breakoutIdx - BASE_WEEKS), breakoutIdx);
  const mid = Math.floor(baseBars.length / 2);
  const firstHalf = baseBars.slice(0, mid);
  const secondHalf = baseBars.slice(mid);
  const low1 = firstHalf.length ? Math.min(...firstHalf.map((r) => r.low)) : null;
  const low2 = secondHalf.length ? Math.min(...secondHalf.map((r) => r.low)) : null;
  const stoppedLowerLows =
    Number.isFinite(low1) && Number.isFinite(low2) ? low2 >= low1 * BASE_LOW_TOLERANCE : false;

  const maFlatOrTurning =
    slopePct >= BASE_SLOPE_MIN_PCT && slopePct <= BASE_SLOPE_MAX_PCT;
  const priorNotMature =
    priorPct >= BASE_PRIOR_MIN_PCT && priorPct <= BASE_PRIOR_MAX_PCT;

  const fail = [];
  if (!hadDecline) {
    fail.push(
      declinePct == null
        ? "更早下跌无法确认"
        : `更早无下跌（52→26 周均线 ${pct(declinePct)}，门槛 ≤−${BASE_DECLINE_MIN_PCT}%）`,
    );
  }
  if (!stoppedLowerLows) {
    fail.push(
      `底座未停止创新低（前半低 ${round(low1)} → 后半低 ${round(low2)}，须 ≥×${BASE_LOW_TOLERANCE}）`,
    );
  }
  if (!maFlatOrTurning) {
    fail.push(
      `突破前均线未走平/刚转（斜率 ${pct(slopePct)}，须在 ${BASE_SLOPE_MIN_PCT}%～+${BASE_SLOPE_MAX_PCT}%）`,
    );
  }
  if (!priorNotMature) {
    fail.push(
      `突破前均线已非底部（前 ${PRIOR_TREND_WEEKS} 周 ${pct(priorPct)}，底座上限 +${BASE_PRIOR_MAX_PCT}%）` +
        (priorPct > BASE_PRIOR_MAX_PCT ? "——属阶段2 中途突破，不是阶段1→2" : ""),
    );
  }

  return {
    ok: fail.length === 0,
    reason: fail.length ? fail.join("；") : "阶段1 底座成立（下跌后横盘、均线走平、停止创新低）",
    slope_pct: round(slopePct),
    prior_pct: round(priorPct),
    decline_pct: round(declinePct),
    stopped_lower_lows: stoppedLowerLows,
    had_decline: hadDecline,
    base_low_first: round(low1, 4),
    base_low_second: round(low2, 4),
  };
}

function loadContext(contextPath) {
  const p = contextPath || tmpPath("rightside_market_context.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 六条件清单。ctx 为 fetch_market_context.js 产出的上下文，industry 为东财 f100 行业名。
 */
export function analyzeStage(weekly, { context = null, industry = null, maType = MA_TYPE } = {}) {
  if (weekly.length < MA_WEEKS + SLOPE_WEEKS + 1) {
    return {
      ok: false,
      error: `周 bar ${weekly.length} 根 < ${MA_WEEKS + SLOPE_WEEKS + 1}，不足以判技术位`,
      weeks: weekly.length,
    };
  }
  const last = weekly.length - 1;
  const t = trendOf(weekly, { maType });
  const close = t.close;
  const ma30 = t.ma30w;
  const devPct = t.dev_pct;
  const slopePct = t.slope_pct;
  const priorPct = t.prior_pct;

  const win52 = weekly.slice(-52);
  const high52 = Math.max(...win52.map((r) => r.high));
  const low52 = Math.min(...win52.map((r) => r.low));
  const ddFromHighPct = ((close - high52) / high52) * 100;
  const upFromLowPct = ((close - low52) / low52) * 100;

  // 阻力区（不含本周）：上沿是突破的触发价，下沿是止损参考
  const base = weekly.slice(-(BASE_WEEKS + 1), -1);
  const baseHigh = Math.max(...base.map((r) => r.high));
  const baseLow = Math.min(...base.map((r) => r.low));

  const vols = weekly.map((r) => r.volume);
  /**
   * 「过去几个月平均周成交量」是**这一周之前**的均量：把突破周自己算进分母会稀释倍数，
   * 一根 3 倍量的周会把自己的比值压到 2 倍出头。故基准窗口一律取 idx 之前的 26 周。
   */
  const avgVolBefore = (idx) => {
    const win = vols.slice(Math.max(0, idx - VOLUME_WINDOW), idx).filter((v) => Number.isFinite(v) && v > 0);
    return win.length >= 8 ? win.reduce((a, b) => a + b, 0) / win.length : null;
  };
  const volAvg = avgVolBefore(last);
  const volNow = vols[last];
  const volRatio = volAvg && Number.isFinite(volNow) ? volNow / volAvg : null;

  /** 某一周是否为「周收盘突破此前 30 周阻力区上沿」，并给出该周的量比与阶段1 底座质量。 */
  const breakoutAt = (i) => {
    const prior = weekly.slice(Math.max(0, i - BASE_WEEKS), i);
    if (!prior.length) return null;
    const priorHigh = Math.max(...prior.map((r) => r.high));
    if (weekly[i].close <= priorHigh) return null;
    const baseAvg = avgVolBefore(i);
    const stage1 = assessStage1Base(weekly, i, { maType });
    return {
      idx: i,
      weeks_ago: last - i,
      vol_ratio: baseAvg && Number.isFinite(vols[i]) ? vols[i] / baseAvg : null,
      prior_high: priorHigh,
      stage1,
    };
  };

  /** 由近及远找最近一次符合 accept 的突破。 */
  const findBreakout = (lookback, accept = () => true) => {
    for (let i = last; i >= MA_WEEKS && i >= last - lookback; i--) {
      const b = breakoutAt(i);
      if (b && accept(b)) return b;
    }
    return null;
  };

  // 条件3/4：「刚突破」且必须带阶段1 底座（中途新高不算）
  const recentBreakout = findBreakout(12, (b) => b.stage1?.ok);
  const breakoutWeeksAgo = recentBreakout?.weeks_ago ?? null;
  const breakoutIdx = recentBreakout?.idx ?? null;
  const breakoutVolRatio = recentBreakout?.vol_ratio ?? null;
  // 最近一次「任意突破」（含无底座），仅用于诊断：说明卡住的是底座而不是没突破
  const anyRecentBreakout = findBreakout(12);
  const recentBaseFail =
    !recentBreakout && anyRecentBreakout?.stage1
      ? anyRecentBreakout.stage1
      : null;

  // 条件5：前置放量突破，且那次突破本身也必须是阶段1→2
  const pullbackBreakout = findBreakout(
    PULLBACK_BREAKOUT_LOOKBACK,
    (b) =>
      b.weeks_ago >= 1 &&
      b.vol_ratio != null &&
      b.vol_ratio >= PULLBACK_BREAKOUT_VOL_MIN &&
      b.stage1?.ok,
  );
  const anyPullbackBreakout = findBreakout(
    PULLBACK_BREAKOUT_LOOKBACK,
    (b) =>
      b.weeks_ago >= 1 && b.vol_ratio != null && b.vol_ratio >= PULLBACK_BREAKOUT_VOL_MIN,
  );
  const pullbackBaseFail =
    !pullbackBreakout && anyPullbackBreakout?.stage1 ? anyPullbackBreakout.stage1 : null;

  // 条件4 备选口径：近 3–4 周合计 vs 这 4 周之前的同跨度平均
  const multiWin = vols.slice(-VOLUME_MULTI_WEEKS).filter((v) => Number.isFinite(v) && v > 0);
  const multiSum = multiWin.length ? multiWin.reduce((a, b) => a + b, 0) : null;
  const multiBaseAvg = avgVolBefore(last - VOLUME_MULTI_WEEKS + 1);
  const multiRatio = multiSum && multiBaseAvg ? multiSum / (multiBaseAvg * VOLUME_MULTI_WEEKS) : null;

  // 条件3「上方阻力最小」：近 104 周里有多少周的最高价还压在现价之上
  const overheadWin = weekly.slice(-OVERHEAD_WEEKS);
  const overheadCount = overheadWin.filter((r) => r.high > close).length;
  const overheadPct = (overheadCount / overheadWin.length) * 100;
  const aboveHighs = overheadWin.filter((r) => r.high > close).map((r) => r.high);
  const nextResistance = aboveHighs.length ? Math.min(...aboveHighs) : null;

  // 条件5 回调缩量：回踩这 3 周的均量 vs 回踩之前的均量
  const pullbackVols = vols.slice(-3).filter((v) => Number.isFinite(v) && v > 0);
  const pullbackBaseAvg = avgVolBefore(last - 2);
  const pullbackRatio =
    pullbackBaseAvg && pullbackVols.length
      ? pullbackVols.reduce((a, b) => a + b, 0) / pullbackVols.length / pullbackBaseAvg
      : null;

  const trendMature = priorPct >= TREND_MATURE_PCT;
  const stage = classifyStage({ devPct, slopePct, priorPct, ddFromHighPct });

  // ── 条件 1：大盘 ─────────────────────────────────────────────
  // 参考项：不参与放行，只在结论里提示逆势风险
  const mk = context?.market;
  const c1 = mk?.ok
    ? {
        pass: Boolean(mk.pass),
        advisory: true,
        detail:
          `${mk.name} 收 ${mk.close}，${mk.above_ma ? "站上" : "跌破"} 30 周均线 ${mk.ma30w}（${pct(mk.dev_pct)}），` +
          `均线近 ${SLOPE_WEEKS} 周${mk.slope_word}（${pct(mk.slope_pct)}）` +
          `${mk.pass ? "" : " → 逆势环境，本条不否决买点，但入场须减小仓位、止损从严"}`,
      }
    : {
        pass: false,
        advisory: true,
        unknown: true,
        detail: `大盘上下文缺失（${mk?.error || "未跑 fetch_market_context.js"}）——参考项，不影响放行`,
      };

  // ── 条件 2：行业 ─────────────────────────────────────────────
  // 参考项：不参与放行，只在结论里提示逆行业风险
  const bd = industry ? context?.boards?.[industry] : null;
  const c2 = bd?.ok
    ? {
        pass: Boolean(bd.pass),
        advisory: true,
        detail:
          `${industry}（${bd.board_code}）${bd.above_ma ? "站上" : "跌破"} 30 周均线（${pct(bd.dev_pct)}），` +
          `均线${bd.slope_word}（${pct(bd.slope_pct)}）；相对大盘 RS ${bd.rs_vs_market?.ok ? bd.rs_vs_market.value : "—"}` +
          `（${bd.outperform ? "跑赢大盘" : "未跑赢大盘"}）` +
          `${bd.pass ? "" : " → 逆行业环境，本条不否决买点，但入场须减小仓位、止损从严"}`,
      }
    : {
        pass: false,
        advisory: true,
        unknown: true,
        detail: `行业上下文缺失（${bd?.error || (industry ? "未拉板块" : "未传 --industry")}）——参考项，不影响放行`,
      };

  // ── 条件 3：阶段1 底座上的突破 + 站上 MA30W + 上方阻力最小 ─────
  const freshBreakout = breakoutWeeksAgo != null && breakoutWeeksAgo <= BREAKOUT_MAX_WEEKS;
  const overheadOk = overheadPct <= OVERHEAD_MAX_PCT;
  const notChasing = devPct <= ENTRY_MAX_DEV_PCT;
  const c3 = {
    pass: Boolean(freshBreakout && t.above_ma && overheadOk && notChasing),
    detail:
      (freshBreakout
        ? `${breakoutWeeksAgo} 周前自阶段1 底座突破 ${BASE_WEEKS} 周阻力区上沿 ${round(recentBreakout.prior_high)}` +
          `（突破前均线斜率 ${pct(recentBreakout.stage1.slope_pct)}、前26周 ${pct(recentBreakout.stage1.prior_pct)}）`
        : recentBaseFail
          ? `近 12 周有突破但非阶段1 底座：${recentBaseFail.reason}`
          : `近 12 周未突破阻力区上沿 ${round(baseHigh)}`) +
      `；${t.above_ma ? "站上" : "未站上"} MA30W ${ma30}（${pct(devPct)}，追高上限 +${ENTRY_MAX_DEV_PCT}%）` +
      `；上方阻力：近 ${OVERHEAD_WEEKS} 周有 ${round(overheadPct)}% 的周高价压在现价之上` +
      `（门槛 ≤${OVERHEAD_MAX_PCT}%${nextResistance ? `，最近一道 ${round(nextResistance)}` : "，上方无成交密集区"}）`,
  };

  // ── 条件 4：突破放量 ≥ 2 倍 ──────────────────────────────────
  const singleOk = volRatio != null && volRatio >= VOLUME_SURGE;
  const breakoutWeekOk = breakoutVolRatio != null && breakoutVolRatio >= VOLUME_SURGE;
  const multiOk =
    multiRatio != null &&
    multiRatio >= VOLUME_MULTI_SURGE &&
    breakoutVolRatio != null &&
    breakoutVolRatio >= BREAKOUT_WEEK_MIN_RATIO;
  const c4 = {
    pass: Boolean(singleOk || breakoutWeekOk || multiOk),
    detail:
      volAvg == null
        ? "量能数据缺失，放量无法确认"
        : `本周量 / 之前 ${VOLUME_WINDOW} 周均量 = ${round(volRatio)}（门槛 ${VOLUME_SURGE}）` +
          `；突破周量比 ${breakoutVolRatio == null ? "—" : round(breakoutVolRatio)}` +
          `；近 ${VOLUME_MULTI_WEEKS} 周合计 / 之前同跨度均量 = ${round(multiRatio)}` +
          `（备选口径门槛 ${VOLUME_MULTI_SURGE}，且突破周须 ≥${BREAKOUT_WEEK_MIN_RATIO}）`,
  };

  // ── 条件 5：回踩 MA30W 且缩量（前置突破必须是阶段1→2）────────
  const inPullbackZone = devPct >= PULLBACK_UNDERCUT_PCT && devPct <= PULLBACK_DEV_PCT;
  const volShrunk = pullbackRatio != null && pullbackRatio <= PULLBACK_VOL_MAX;
  const hasPriorBreakout = pullbackBreakout != null;
  const c5 = {
    pass: Boolean(inPullbackZone && slopePct > 0 && volShrunk && trendMature && hasPriorBreakout),
    detail:
      `距 MA30W ${pct(devPct)}（回踩区 ${PULLBACK_UNDERCUT_PCT}%～+${PULLBACK_DEV_PCT}%）` +
      `；均线${t.slope_word}（${pct(slopePct)}）` +
      `；近 3 周均量 / 回踩前 ${VOLUME_WINDOW} 周均量 = ${round(pullbackRatio)}（缩量门槛 ≤${PULLBACK_VOL_MAX}）` +
      `；前 ${PRIOR_TREND_WEEKS} 周均线 ${pct(priorPct)}（≥${TREND_MATURE_PCT}% 才算趋势已确立，当前${trendMature ? "已确立" : "未确立"}）` +
      `；前置阶段1→2 放量突破${
        hasPriorBreakout
          ? `：${pullbackBreakout.weeks_ago} 周前自底座突破，突破周量比 ${round(pullbackBreakout.vol_ratio)}` +
            `（突破前均线斜率 ${pct(pullbackBreakout.stage1.slope_pct)}、前26周 ${pct(pullbackBreakout.stage1.prior_pct)}）`
          : pullbackBaseFail
            ? `：近 ${PULLBACK_BREAKOUT_LOOKBACK} 周有放量突破但非阶段1 底座——${pullbackBaseFail.reason}`
            : `：近 ${PULLBACK_BREAKOUT_LOOKBACK} 周内无量比 ≥${PULLBACK_BREAKOUT_VOL_MIN} 的阶段1→2 突破，贴均线不算回踩买点`
      }`,
  };

  // ── 条件 6：相对强度 ────────────────────────────────────────
  const rs = context?.index_weekly ? mansfieldRS(weekly, context.index_weekly) : { ok: false, error: "缺指数序列" };
  const c6 = rs.ok
    ? {
        pass: Boolean(rs.positive || rs.turned_positive),
        forbid: Boolean(rs.shape_poor),
        detail:
          `Mansfield RS（股价/${context?.market?.name || "大盘"} ÷ 自身 ${RS_WEEKS} 周均值）= ${rs.value}` +
          `，位于零轴${rs.positive ? "之上" : "之下"}` +
          `${rs.turned_positive ? "（近 8 周由负转正）" : ""}` +
          `；近 ${RS_SLOPE_WEEKS} 周${rs.rising ? "上行" : "下行"}` +
          `${rs.shape_poor ? " → 负值且形态走弱，**禁止买入**" : ""}`,
      }
    : { pass: false, unknown: true, detail: `相对强度无法计算（${rs.error}）` };

  const checks = [
    { id: 1, name: "大盘趋势向好（参考项，不否决）", ...c1 },
    { id: 2, name: "行业表现不错（参考项，不否决）", ...c2 },
    { id: 3, name: "阶段1底座上突破阻力区并站上30周均线，上方阻力最小", ...c3 },
    { id: 4, name: `突破量能 ≥ 均量 ${VOLUME_SURGE} 倍`, ...c4 },
    { id: 5, name: "回撤到30周均线附近且回调缩量（前置须为阶段1→2突破）", ...c5 },
    { id: 6, name: "相对强度在零轴之上或由负转正", ...c6 },
  ];

  // 条件1/2 是参考项，不进 gate；大盘或行业不好只降级为提示
  const gate = c6.pass && !c6.forbid;
  const breakoutBuy = gate && c3.pass && c4.pass;
  const pullbackBuy = gate && c5.pass;
  const marketWarning = c1.pass
    ? null
    : c1.unknown
      ? "大盘上下文缺失，无法评估系统性风险，建议先补跑 fetch_market_context.js"
      : `逆势提示：${mk.name} 在 30 周均线之下（${pct(mk.dev_pct)}、斜率 ${pct(mk.slope_pct)}），` +
        "此时入场属逆大盘操作，建议减小仓位并把止损收紧到阻力区下沿";
  const industryWarning = c2.pass
    ? null
    : c2.unknown
      ? "行业上下文缺失，无法评估行业顺逆，建议补传 --industry / 重跑 fetch_market_context.js"
      : `逆行业提示：${industry || "所属行业"} 未站上 30 周均线或均线走弱` +
        `${bd?.ok ? `（${pct(bd.dev_pct)}、斜率 ${pct(bd.slope_pct)}）` : ""}，` +
        "个股再强也属逆行业操作，建议减小仓位、止损从严";
  const advisoryTips = [marketWarning, industryWarning].filter(Boolean);
  const advisorySuffix = advisoryTips.length ? `。${advisoryTips.join("；")}` : "";

  let action = "观望";
  let entryKind = null;
  let actionReason;
  if (breakoutBuy) {
    action = "建仓建议";
    entryKind = "突破买点";
    actionReason =
      `买点成立（突破买点）：相对强度 ${rs.value} 在零轴之上；` +
      `${breakoutWeeksAgo} 周前自阶段1 底座放量突破阻力区 ${round(recentBreakout.prior_high)}` +
      `（突破周量比 ${round(breakoutVolRatio ?? volRatio)}），` +
      `现价距均线 ${pct(devPct)}，上方阻力仅 ${round(overheadPct)}%` +
      advisorySuffix;
  } else if (pullbackBuy) {
    action = "建仓建议";
    entryKind = "回踩买点";
    actionReason =
      `买点成立（回踩买点）：相对强度 ${rs.value} 在零轴之上；` +
      `${pullbackBreakout.weeks_ago} 周前自阶段1 底座放量突破（突破周量比 ${round(pullbackBreakout.vol_ratio)}），` +
      `此后股价回撤到 30 周上升均线附近（${pct(devPct)}）且回调缩量（近 3 周均量为均量的 ${round(pullbackRatio)} 倍）` +
      advisorySuffix;
  } else if (c6.forbid) {
    actionReason = `禁止买入：相对强度 ${rs.value} 位于负值区且形态走弱（近 ${RS_SLOPE_WEEKS} 周继续下行），无论个股形态多好都不碰`;
  } else {
    const blockers = checks.filter((c) => !c.pass && c.id === 6);
    if (blockers.length) {
      actionReason = `观望：相对强度未过——条件6 ${c6.detail}`;
    } else {
      const c3Block = !c3.pass
        ? recentBaseFail
          ? " 条件3（突破非阶段1底座）"
          : " 条件3（未突破或上方阻力过重）"
        : "";
      const c5Block = !inPullbackZone
        ? "不在回踩区"
        : !hasPriorBreakout
          ? pullbackBaseFail
            ? "前置突破非阶段1底座"
            : `近 ${PULLBACK_BREAKOUT_LOOKBACK} 周无前置阶段1→2放量突破`
          : !trendMature
            ? "趋势未确立"
            : !volShrunk
              ? "回调未缩量"
              : "均线未向上";
      actionReason =
        `观望：相对强度已通过，但两个买点都不成立——` +
        `突破买点卡在${c3Block}${!c3.pass && !c4.pass ? "、" : ""}${!c4.pass ? " 条件4（量能未达 2 倍）" : ""}；` +
        `回踩买点卡在 条件5（${c5Block}）。` +
        `触发价：放量站上 ${round(baseHigh)}`;
    }
  }

  const stopLoss = Math.min(baseLow, ma30) * 0.97;

  return {
    ok: true,
    as_of: weekly[last].date,
    weeks: weekly.length,
    industry: industry || null,
    ma_type: maType,
    stage,
    stage_label: STAGE_PLAYBOOK[stage].label,
    strategy: STAGE_PLAYBOOK[stage].strategy,
    checks,
    checks_passed: checks.filter((c) => c.pass).length,
    gate_passed: gate,
    entry_kind: entryKind,
    market_warning: marketWarning,
    industry_warning: industryWarning,
    metrics: {
      close: round(close, 4),
      ma30w: round(ma30, 4),
      dev_pct: round(devPct),
      slope_pct: round(slopePct),
      slope_word: t.slope_word,
      prior_pct: round(priorPct),
      trend_mature: trendMature,
      high52w: round(high52, 4),
      low52w: round(low52, 4),
      dd_from_high_pct: round(ddFromHighPct),
      up_from_low_pct: round(upFromLowPct),
      base_high: round(baseHigh, 4),
      base_low: round(baseLow, 4),
      breakout_weeks_ago: breakoutWeeksAgo,
      vol_ratio: round(volRatio),
      breakout_vol_ratio: round(breakoutVolRatio),
      multi_week_vol_ratio: round(multiRatio),
      pullback_vol_ratio: round(pullbackRatio),
      pullback_breakout_weeks_ago: pullbackBreakout?.weeks_ago ?? null,
      pullback_breakout_vol_ratio: round(pullbackBreakout?.vol_ratio),
      stage1_base_ok: Boolean(recentBreakout?.stage1?.ok || pullbackBreakout?.stage1?.ok),
      stage1_base_reason:
        recentBreakout?.stage1?.reason ||
        pullbackBreakout?.stage1?.reason ||
        recentBaseFail?.reason ||
        pullbackBaseFail?.reason ||
        null,
      stage1_at_breakout_slope:
        recentBreakout?.stage1?.slope_pct ?? pullbackBreakout?.stage1?.slope_pct ?? null,
      stage1_at_breakout_prior:
        recentBreakout?.stage1?.prior_pct ?? pullbackBreakout?.stage1?.prior_pct ?? null,
      overhead_pct: round(overheadPct),
      next_resistance: round(nextResistance),
      rs: rs.ok ? rs.value : null,
      rs_positive: rs.ok ? rs.positive : null,
      rs_turned_positive: rs.ok ? rs.turned_positive : null,
      rs_shape_poor: rs.ok ? rs.shape_poor : null,
    },
    action,
    action_reason: actionReason,
    trigger_price: round(baseHigh),
    stop_loss: round(stopLoss, 4),
    exit_signals: [
      "周收盘跌破 30 周均线且均线转平/向下 → 阶段3→4，离场",
      `跌破止损参考 ${round(stopLoss, 4)}（阻力区下沿与均线孰低再让 3%）无条件离场`,
      "相对强度跌回零轴之下并持续走弱 → 减持",
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { positional: ["input"] });
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
  if (meta.adjust && meta.adjust !== "forward" && meta.fqt !== 1) {
    console.error(JSON.stringify({ error: "技术位判定必须用前复权（--adjust forward / fqt=1）" }));
    return 1;
  }
  const weekly = toWeeklyBars(bars, meta.period === "week" ? "week" : null);
  const context = loadContext(args.context);
  const maType = String(args.maType || args["ma-type"] || MA_TYPE).toLowerCase();
  if (!["wma", "sma"].includes(maType)) {
    console.error(JSON.stringify({ error: "--ma-type 须为 wma|sma" }));
    return 1;
  }
  const result = analyzeStage(weekly, { context, industry: args.industry || null, maType });
  console.log(
    JSON.stringify(
      { code: meta.code || meta.ts_code || null, adjust: meta.adjust || "forward", ...result },
      null,
      2,
    ),
  );
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
