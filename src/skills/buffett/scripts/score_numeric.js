#!/usr/bin/env node
/**
 * Step 2 全量数字评分：同类（同一 f100）分位为主尺。
 * 绝对值 knot / 过热帽不进得分；红线仍走 red_hints。
 * 不定红线终评、不写桌面终报。
 *
 * 用法: node score_numeric.js --self-test
 */

import { parseArgs } from "./opencli_json.js";
import { anchorProfile, metricSource } from "./anchor_config.js";
import { classPbAnchor, finKindFromF100 } from "./industry_map.js";

export const GRADES = [0, 20, 50, 80, 100];
export const MIN_PEER = 4;
export const OVERHEAT_MIN_YEARS = 5;

export const WEIGHTS = {
  corp: {
    fcf: 0.25,
    roic_durability: 0.1,
    margin_durability: 0.07,
    dividend_discipline: 0.1,
    pay: 0.14,
    roe: 0.14,
    pb: 0.1,
    debt: 0.1,
  },
  bank: {
    asset: 0.25,
    cet1: 0.14,
    pay: 0.15,
    roe: 0.1,
    nim_trend: 0.1,
    pb: 0.1,
    dividend_discipline: 0.09,
    roe_stability: 0.07,
  },
  insurance: {
    solvency: 0.18,
    solvency_trend: 0.08,
    pay: 0.15,
    roe: 0.18,
    roi_trend: 0.1,
    pb: 0.1,
    dividend_discipline: 0.09,
    roe_stability: 0.12,
  },
  broker: {
    roe_stability: 0.25,
    pay: 0.15,
    roe: 0.15,
    dividend_discipline: 0.1,
    pb: 0.1,
    debt: 0.25,
  },
};

export const DIM_LABEL = {
  fcf: "FCF覆盖",
  pay: "派息",
  roe: "ROE(3年)",
  pb: "PB",
  debt: "负债率",
  asset: "资产质量",
  cet1: "核充率",
  nim_trend: "净息差",
  solvency: "偿付充足",
  solvency_trend: "偿付趋势",
  roi_trend: "投资收益趋势",
  roic_durability: "ROIC持久性",
  margin_durability: "毛利率持久性",
  dividend_discipline: "分红纪律",
  roe_stability: "ROE稳定性",
};

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function normF100(raw) {
  return String(raw || "")
    .replace(/[ⅠⅡⅢIVX\s]/g, "")
    .trim();
}

export function median(xs) {
  const a = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function snapGrade(x) {
  if (x == null || !Number.isFinite(Number(x))) return null;
  const v = Number(x);
  return GRADES.reduce((b, g) => (Math.abs(g - v) < Math.abs(b - v) ? g : b));
}

/** 分段线性插值；knots 按 x 升序，端点外 clamp。 */
export function linearScore(x, knots) {
  const v = fnum(x);
  if (v == null || !knum(knots)) return null;
  const pts = knots
    .map((k) => ({ x: Number(k.x), y: Number(k.y) }))
    .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.y))
    .sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  if (v <= pts[0].x) return Math.round(pts[0].y);
  if (v >= pts[pts.length - 1].x) return Math.round(pts[pts.length - 1].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (v >= a.x && v <= b.x) {
      if (b.x === a.x) return Math.round(b.y);
      const t = (v - a.x) / (b.x - a.x);
      return Math.round(a.y + t * (b.y - a.y));
    }
  }
  return Math.round(pts[pts.length - 1].y);
}

/** 取值所在 knot 段的 [min,max] 得分区间（供同类分位夹段）。 */
export function linearBandAt(x, knots) {
  const v = fnum(x);
  if (v == null || !knum(knots)) return null;
  const pts = knots
    .map((k) => ({ x: Number(k.x), y: Number(k.y) }))
    .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.y))
    .sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  if (v <= pts[0].x) return { min: pts[0].y, max: pts[0].y };
  if (v >= pts[pts.length - 1].x) {
    const y = pts[pts.length - 1].y;
    return { min: y, max: y };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (v >= a.x && v <= b.x) {
      return { min: Math.min(a.y, b.y), max: Math.max(a.y, b.y) };
    }
  }
  return null;
}

function knum(knots) {
  return Array.isArray(knots) && knots.length > 0;
}

/** 含自身；n<2 无法分位。越高越好：平均秩。同分得中位，避免全员相同变成 0。 */
export function percentileHigher(value, peersInclSelf) {
  const v = fnum(value);
  const xs = (peersInclSelf || []).map(fnum).filter((x) => x != null);
  if (v == null || xs.length < 2) return null;
  const worse = xs.filter((x) => x < v).length;
  const equal = xs.filter((x) => x === v).length;
  return ((worse + (equal - 1) / 2) / (xs.length - 1)) * 100;
}

export function percentileLower(value, peersInclSelf) {
  const v = fnum(value);
  const xs = (peersInclSelf || []).map(fnum).filter((x) => x != null);
  if (v == null || xs.length < 2) return null;
  const worse = xs.filter((x) => x > v).length;
  const equal = xs.filter((x) => x === v).length;
  return ((worse + (equal - 1) / 2) / (xs.length - 1)) * 100;
}

/** @deprecated 保留兼容；新逻辑用 pctToScore（连续 0–100）。 */
export function pctToBucket(pct) {
  return pctToScore(pct);
}

/** 同类分位 → 连续得分 0–100（线性，不再五档跳变）。 */
export function pctToScore(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

export function ratingOf(total) {
  if (total == null || !Number.isFinite(total)) return "⚠️";
  if (total >= 80) return "🟢";
  if (total >= 70) return "🟡";
  if (total >= 60) return "🟠";
  return "🔴";
}

/** 同类仅同一东财 f100。分位主尺；n<2 无信息给 50。 */
export function peerGroup(card, cards) {
  const f100 = normF100(card.f100);
  if (!f100) return { peers: [], key: "f100:", n: 0, escalated: false };
  const peers = (cards || []).filter((c) => normF100(c.f100) === f100);
  return { peers, key: `f100:${f100}`, n: peers.length, escalated: false };
}

export function roeKnots(f100) {
  const a = fnum(anchorProfile(f100).metrics.roe?.anchor);
  if (a == null) return null;
  return [
    { x: a - 5, y: 0 },
    { x: a - 3, y: 20 },
    { x: a, y: 50 },
    { x: a + 4, y: 80 },
    { x: a + 8, y: 100 },
  ];
}

export function roeBand(f100, roe) {
  const knots = roeKnots(f100);
  const v = fnum(roe);
  if (!knots || v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

export function pbKnots(f100) {
  const p = fnum(anchorProfile(f100).metrics.pb?.anchor) ?? classPbAnchor(f100);
  if (p == null) return null;
  return [
    { x: 0, y: 100 },
    { x: p * 0.6, y: 80 },
    { x: p, y: 50 },
    { x: p * 1.4, y: 20 },
    { x: p * 2, y: 0 },
    { x: p * 4, y: 0 },
  ];
}

export function pbBand(f100, pb) {
  const v = fnum(pb);
  if (v == null || v <= 0) return null;
  const knots = pbKnots(f100);
  if (!knots) return { min: 0, max: 100, zone: "peer-only-no-pb-anchor" };
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  const approved = fnum(anchorProfile(f100).metrics.pb?.anchor);
  return { ...band, zone, source: approved != null ? "f100" : "class" };
}

export function debtKnots(f100) {
  const d = fnum(anchorProfile(f100).metrics.debt?.anchor);
  if (d == null) return null;
  return [
    { x: 0, y: 100 },
    { x: d - 15, y: 80 },
    { x: d, y: 50 },
    { x: d + 10, y: 20 },
    { x: d + 20, y: 0 },
    { x: d + 40, y: 0 },
  ];
}

export function debtBand(f100, debt) {
  const knots = debtKnots(f100);
  const v = fnum(debt);
  if (!knots || v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

export function fcfKnots() {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 10 },
    { x: 0.8, y: 20 },
    { x: 1.0, y: 50 },
    { x: 1.5, y: 80 },
    { x: 3, y: 100 },
  ];
}

/** minCover<1 → 再高也最多 50（差的里面第一仍盖不住分红）。 */
export function fcfBand(cover, minCover) {
  const v = fnum(cover);
  if (v == null) return null;
  const knots = fcfKnots();
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  let { min, max } = band;
  let zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  if (fnum(minCover) != null && minCover < 1) {
    max = Math.min(max, 50);
    zone = `${zone}|cover<1`;
  }
  return { min, max, zone };
}

export function payKnots(f100, fcfOk) {
  const band = anchorProfile(f100).metrics.pay?.band;
  if (!band) return null;
  const [lo, hi] = band;
  const wlo = Math.max(0, lo - 10);
  const whi = hi + 10;
  const knots = [
    { x: 0, y: 5 },
    { x: Math.max(0, wlo - 10), y: 20 },
    { x: wlo, y: 50 },
    { x: (wlo + whi) / 2, y: 75 },
    { x: whi, y: 100 },
  ];
  if (fcfOk) {
    knots.push({ x: whi + 10, y: 80 }, { x: whi + 25, y: 65 }, { x: 150, y: 50 });
  } else {
    knots.push({ x: whi + 10, y: 45 }, { x: whi + 25, y: 30 }, { x: 150, y: 15 });
  }
  return knots.sort((a, b) => a.x - b.x);
}

export function payBand(f100, pay, fcfOk) {
  const v = fnum(pay);
  if (v == null) return null;
  if (v > 100) return { min: 0, max: 0, zone: "red>100" };
  const knots = payKnots(f100, fcfOk);
  if (!knots) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const payBandAnchor = anchorProfile(f100).metrics.pay?.band;
  const lo = payBandAnchor?.[0] ?? 0;
  const hi = payBandAnchor?.[1] ?? 0;
  const wlo = Math.max(0, lo - 10);
  const whi = hi + 10;
  let zone = "healthy";
  if (v > whi) zone = fcfOk ? "high-ok" : "high-weak";
  else if (v < wlo) zone = "low";
  if (score <= 15) zone = "very-low";
  return { ...band, zone };
}

export function nplKnots() {
  return [
    { x: 0, y: 100 },
    { x: 0.9, y: 90 },
    { x: 1.5, y: 65 },
    { x: 2.0, y: 35 },
    { x: 3.0, y: 10 },
    { x: 5, y: 0 },
  ];
}

export function nplBand(npl) {
  const knots = nplKnots();
  const v = fnum(npl);
  if (v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

export function provisionKnots() {
  return [
    { x: 0, y: 0 },
    { x: 120, y: 10 },
    { x: 150, y: 20 },
    { x: 180, y: 50 },
    { x: 250, y: 80 },
    { x: 400, y: 100 },
  ];
}

export function provisionBand(prov) {
  const knots = provisionKnots();
  const v = fnum(prov);
  if (v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

export function cet1Knots() {
  return [
    { x: 0, y: 0 },
    { x: 8, y: 10 },
    { x: 9.5, y: 20 },
    { x: 11, y: 50 },
    { x: 13, y: 80 },
    { x: 16, y: 100 },
  ];
}

export function cet1Band(cet1) {
  const knots = cet1Knots();
  const v = fnum(cet1);
  if (v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

export function solvencyKnots() {
  // 综合偿付：监管附近低分；180–220 为健康带；超额资本封顶 90（线性插值）。
  return [
    { x: 0, y: 0 },
    { x: 100, y: 10 },
    { x: 150, y: 50 },
    { x: 180, y: 80 },
    { x: 220, y: 90 },
    { x: 280, y: 90 },
  ];
}

export function solvencyBand(sol) {
  const knots = solvencyKnots();
  const v = fnum(sol);
  if (v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

/** 相对自身中位数：≥2 倍帽 50；≥1.5 倍帽 80。自身历史高分位须同时 ≥1.3 倍才戴帽（避免 12–14% 窄波动误伤）。不足 5 年不戴帽。 */
export function overheatCap(current, histVals) {
  const v = fnum(current);
  const hist = (histVals || []).map(fnum).filter((x) => x != null);
  if (v == null || v <= 0 || hist.length < OVERHEAT_MIN_YEARS) {
    return { cap: null, reason: null, median: median(hist), n: hist.length };
  }
  const med = median(hist);
  if (med == null || med <= 0) return { cap: null, reason: null, median: med, n: hist.length };
  const ratio = v / med;
  const ownPct = percentileHigher(v, hist);
  if (ratio >= 2) {
    return { cap: 50, reason: `自身${ratio.toFixed(1)}×中位数${med.toFixed(1)}`, median: med, n: hist.length };
  }
  if (ratio >= 1.5 || (ownPct != null && ownPct >= 80 && ratio >= 1.3)) {
    return {
      cap: 80,
      reason: `自身过热(比中位数${ratio.toFixed(1)}×/自身分位${ownPct == null ? "—" : ownPct.toFixed(0)})`,
      median: med,
      n: hist.length,
    };
  }
  return { cap: null, reason: null, median: med, n: hist.length };
}

export function nimTrendScore(newer, older) {
  const a = fnum(newer);
  const b = fnum(older);
  if (a == null || b == null) return { score: null, zone: "missing" };
  const chg = a - b;
  const score = linearScore(chg, [
    { x: -0.2, y: 0 },
    { x: -0.08, y: 20 },
    { x: 0, y: 50 },
    { x: 0.08, y: 80 },
    { x: 0.2, y: 100 },
  ]);
  const zone = chg >= 0.08 ? "up" : chg >= -0.08 ? "flat" : chg >= -0.2 ? "down" : "down-hard";
  return { score, zone };
}

/** 净息差水平（百分点）。主尺；两年变动只做弱于同业时的封顶。 */
export function nimLevelKnots() {
  return [
    { x: 0.7, y: 0 },
    { x: 1.0, y: 20 },
    { x: 1.3, y: 50 },
    { x: 1.6, y: 80 },
    { x: 2.1, y: 100 },
  ];
}

export function nimLevelBand(nim) {
  const knots = nimLevelKnots();
  const v = fnum(nim);
  if (v == null) return null;
  const band = linearBandAt(v, knots);
  const score = linearScore(v, knots);
  if (!band) return null;
  const zone =
    score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "ok" : score > 0 ? "weak" : "bad";
  return { ...band, zone };
}

/**
 * 同业也在收窄则不罚；只有明显弱于同业中位才戴帽。
 * 无足够同业样本时，仅对两年下降 ≥0.20pct 戴帽 50。
 */
export function nimTrendCap(chg, peerChgs) {
  const delta = fnum(chg);
  if (delta == null) return { cap: null, reason: null };
  const xs = (peerChgs || []).map(fnum).filter((x) => x != null);
  const med = xs.length >= MIN_PEER ? median(xs) : null;
  if (med == null) {
    if (delta <= -0.2) return { cap: 50, reason: "净息差两年下降≥0.20" };
    return { cap: null, reason: null };
  }
  if (delta >= med - 0.03) {
    return { cap: null, reason: `两年变动${delta.toFixed(2)}贴近同业中位${med.toFixed(2)}` };
  }
  if (delta <= -0.2) return { cap: 20, reason: "净息差两年下降≥0.20且弱于同业" };
  if (delta <= -0.08) return { cap: 80, reason: "净息差两年下降>0.08且弱于同业" };
  return { cap: null, reason: null };
}

export function relTrendScore(newer, older) {
  const a = fnum(newer);
  const b = fnum(older);
  if (a == null || b == null || b === 0) return { score: null, zone: "missing" };
  const rel = (a - b) / Math.abs(b);
  const score = linearScore(rel, [
    { x: -0.15, y: 0 },
    { x: -0.05, y: 20 },
    { x: 0, y: 50 },
    { x: 0.05, y: 80 },
    { x: 0.15, y: 100 },
  ]);
  const zone = rel >= 0.05 ? "up" : rel >= -0.05 ? "flat" : rel >= -0.15 ? "down" : "down-hard";
  return { score, zone };
}

/** 保险趋势：同类 ≥3 家时用「自身变动 − 同业中位」；否则退回自身百分点。 */
export const MIN_TREND_PEER = 3;

export function solvencyTrendKnotsOwn() {
  return [
    { x: -30, y: 0 },
    { x: -20, y: 20 },
    { x: -10, y: 50 },
    { x: 0, y: 70 },
    { x: 15, y: 90 },
    { x: 25, y: 100 },
  ];
}

export function solvencyTrendKnotsVsPeer() {
  return [
    { x: -25, y: 0 },
    { x: -15, y: 20 },
    { x: -8, y: 50 },
    { x: 0, y: 70 },
    { x: 10, y: 90 },
    { x: 20, y: 100 },
  ];
}

export function scoreSolvencyTrend(delta, peerDeltas) {
  const d = fnum(delta);
  if (d == null) return { score: null, reasons: ["偿付趋势缺两年"] };
  const xs = (peerDeltas || []).map(fnum).filter((x) => x != null);
  const med = xs.length >= MIN_TREND_PEER ? median(xs) : null;
  if (med == null) {
    return {
      score: linearScore(d, solvencyTrendKnotsOwn()),
      reasons: [`自身变动${d.toFixed(1)}pct；同业不足${MIN_TREND_PEER}只用自身线性`],
    };
  }
  const rel = d - med;
  return {
    score: linearScore(rel, solvencyTrendKnotsVsPeer()),
    reasons: [`自身${d.toFixed(1)}pct｜同业中位${med.toFixed(1)}｜相对${rel.toFixed(1)}pct`],
  };
}

/**
 * 只按同类分位打分（0–100）。绝对值 knot / 过热帽不进得分。
 * 有效样本 <2：无信息 → 50。
 */
export function finishScore({ pct, n }) {
  const nn = Number(n) || 0;
  if (nn < 2) {
    return { score: 50, reasons: [`同类有效n=${nn}<2，分位无信息→50`] };
  }
  const score = pctToScore(pct);
  if (score == null) return { score: null, reasons: ["分位不足"] };
  return { score, reasons: [`同类分位${score}（n=${nn}）`] };
}

function gapHit(card, re) {
  return (card.data_gaps || []).some((x) => re.test(String(x)));
}

function fcfMetric(card) {
  if (gapHit(card, /FCF量级/)) return { value: null, minCover: null, suspect: true };
  const covers = (card.fcf_cov || []).map((r) => fnum(r.cover)).filter((x) => x != null);
  if (!covers.length) return { value: null, minCover: null, suspect: false };
  const value = covers.reduce((a, b) => a + b, 0) / covers.length;
  return { value, minCover: Math.min(...covers), suspect: false };
}

function histRoe(card) {
  if (Array.isArray(card.roe_hist) && card.roe_hist.length) {
    return card.roe_hist.map((r) => fnum(r.roe ?? r)).filter((x) => x != null);
  }
  return (card.roe_vals || []).map(fnum).filter((x) => x != null);
}

function histPay(card) {
  if (Array.isArray(card.pay_hist) && card.pay_hist.length) {
    return card.pay_hist.map((r) => fnum(r.pay_pct ?? r)).filter((x) => x != null);
  }
  return [];
}

function dpsCutCount(card) {
  const rows = (card.pay_hist || []).filter((row) => fnum(row.dps) != null && fnum(row.dps) > 0).slice(0, 5);
  if (rows.length < 3) return null;
  let cuts = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    if (Number(rows[i].dps) < Number(rows[i + 1].dps) * 0.95) cuts += 1;
  }
  return cuts;
}

function roeCvOf(card) {
  const history = histRoe(card).slice(0, 5);
  if (history.length < 3) return null;
  const med = median(history);
  if (med == null || med <= 0) return null;
  const sigma = stdev(history);
  if (sigma == null) return null;
  return sigma / med;
}

function durabilityMedian(card, key) {
  const s = card.durability_evidence?.[key];
  const hist = (s?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (hist.length < 3) return null;
  return fnum(s?.median) ?? median(hist);
}

function durabilitySigma(card, key) {
  const s = card.durability_evidence?.[key];
  const hist = (s?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (hist.length < 3) return null;
  return fnum(s?.stdev) ?? stdev(hist);
}

function stdev(xs) {
  const values = (xs || []).map(fnum).filter((x) => x != null);
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function capScore(score, cap, reason, reasons) {
  if (score > cap) {
    reasons.push(reason);
    return cap;
  }
  return score;
}

export function roicDurabilityScore(summary, f100 = "") {
  const history = (summary?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (history.length < 3) return { score: null, value: summary || null, reasons: ["ROIC历史不足3年"] };
  const med = fnum(summary?.median) ?? median(history);
  if (med == null) return { score: null, value: summary || null, reasons: ["ROIC中位缺失"] };
  const profile = anchorProfile(f100);
  const roicMetric = profile.metrics.roic || {};
  const anchor = fnum(roicMetric.anchor);
  if (anchor == null) return { score: null, value: summary || null, reasons: [`f100=${f100 || "无"} 缺 ROIC 锚`] };
  let score = linearScore(med / anchor, [
    { x: 0.4, y: 0 },
    { x: 0.7, y: 20 },
    { x: 1.0, y: 50 },
    { x: 1.5, y: 80 },
    { x: 2.0, y: 100 },
  ]);
  const reasons = [
    `${history.length}年中位${med.toFixed(2)}%，f100锚${anchor}%→${score}`,
    metricSource(profile, "roic"),
  ];
  const sigma = fnum(summary?.stdev) ?? stdev(history);
  const cv = sigma == null || Math.abs(med) < 0.01 ? null : sigma / Math.abs(med);
  if (cv != null && roicMetric.cv_cuts) {
    const [cv80, cv50, cv20] = roicMetric.cv_cuts;
    const cvCap = linearScore(cv, [
      { x: 0, y: 100 },
      { x: cv80, y: 80 },
      { x: cv50, y: 50 },
      { x: cv20, y: 20 },
      { x: cv20 * 1.5, y: 0 },
    ]);
    if (cvCap != null && cvCap < score) {
      score = cvCap;
      reasons.push(`波动CV=${cv.toFixed(2)}线性帽→${score}`);
    }
  }
  const latest = history[0];
  const oldest = history[history.length - 1];
  if (oldest > 0 && latest < oldest * 0.5) {
    score = capScore(score, 20, "较最早年度下降超过50%，帽20", reasons);
  } else if (oldest > 0 && latest < oldest * 0.7) {
    score = capScore(score, 50, "较最早年度下降超过30%，帽50", reasons);
  }
  if (history.length < 5) score = capScore(score, 80, `${history.length}年<5年，帽80`, reasons);
  return { score, value: summary, reasons };
}

export function marginDurabilityScore(summary, f100 = "") {
  const history = (summary?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (history.length < 3) return { score: null, value: summary || null, reasons: ["毛利率历史不足3年"] };
  const profile = anchorProfile(f100);
  const cuts = profile.metrics.margin_sigma?.cuts;
  if (!cuts) return { score: null, value: summary || null, reasons: [`f100=${f100 || "无"} 缺毛利率波动锚`] };
  const [c100, c80, c50, c20] = cuts;
  const sigma = fnum(summary?.stdev) ?? stdev(history);
  let score = linearScore(sigma, [
    { x: 0, y: 100 },
    { x: c100, y: 100 },
    { x: c80, y: 80 },
    { x: c50, y: 50 },
    { x: c20, y: 20 },
    { x: c20 * 2, y: 0 },
  ]);
  const reasons = [
    `${history.length}年波动σ=${sigma.toFixed(2)}pct→${score}`,
    metricSource(profile, "margin_sigma"),
  ];
  const change = history[0] - history[history.length - 1];
  if (change <= -10) score = capScore(score, 20, `较最早年度下降${Math.abs(change).toFixed(1)}pct，帽20`, reasons);
  else if (change <= -5) score = capScore(score, 50, `较最早年度下降${Math.abs(change).toFixed(1)}pct，帽50`, reasons);
  if (history.length < 5) score = capScore(score, 80, `${history.length}年<5年，帽80`, reasons);
  return { score, value: summary, reasons };
}

export function dividendDisciplineScore(payHistory) {
  const rows = (payHistory || []).filter((row) => fnum(row.dps) != null && fnum(row.dps) > 0).slice(0, 5);
  if (rows.length < 3) return { score: null, value: { years: rows.length }, reasons: ["每股股息历史不足3年"] };
  let cuts = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    if (Number(rows[i].dps) < Number(rows[i + 1].dps) * 0.95) cuts += 1;
  }
  let score = linearScore(cuts, [
    { x: 0, y: 100 },
    { x: 1, y: 50 },
    { x: 2, y: 20 },
    { x: 3, y: 0 },
    { x: 5, y: 0 },
  ]);
  const paySigma = stdev(rows.map((row) => row.pay_pct));
  const reasons = [`DPS下调${cuts}次→${score}`];
  if (paySigma != null) {
    const sigmaCap = linearScore(paySigma, [
      { x: 0, y: 100 },
      { x: 10, y: 80 },
      { x: 20, y: 50 },
      { x: 30, y: 20 },
      { x: 50, y: 0 },
    ]);
    if (sigmaCap != null && sigmaCap < score) {
      score = sigmaCap;
      reasons.push(`派息率波动σ=${paySigma.toFixed(1)}pct线性帽→${score}`);
    }
  }
  if (rows.length < 5) score = capScore(score, 80, `${rows.length}年<5年，帽80`, reasons);
  if (rows.length >= 2 && Number(rows[0].dps) < Number(rows[1].dps) * 0.8) {
    score = capScore(score, 20, "最新DPS同比下调超过20%，帽20", reasons);
  }
  return {
    score,
    value: { years: rows.length, cuts, payout_stdev: paySigma, dps: rows.map((row) => ({ year: row.year, dps: row.dps })) },
    reasons,
  };
}

export function roeStabilityScore(values, f100 = "") {
  const history = (values || []).map(fnum).filter((x) => x != null).slice(0, 5);
  if (history.length < 3) return { score: null, value: { history }, reasons: ["ROE历史不足3年"] };
  const med = median(history);
  if (med == null || med <= 0) return { score: 0, value: { history, median: med }, reasons: ["ROE中位≤0"] };
  const sigma = stdev(history);
  const cv = sigma / med;
  const profile = anchorProfile(f100);
  const cuts = profile.metrics.roe_cv?.cuts;
  if (!cuts) return { score: null, value: { history, median: med, cv }, reasons: [`f100=${f100 || "无"} 缺 ROE 稳定性锚`] };
  const [c100, c80, c50, c20] = cuts;
  let score = linearScore(cv, [
    { x: 0, y: 100 },
    { x: c100, y: 100 },
    { x: c80, y: 80 },
    { x: c50, y: 50 },
    { x: c20, y: 20 },
    { x: c20 * 2, y: 0 },
  ]);
  const reasons = [
    `${history.length}年ROE波动CV=${cv.toFixed(2)}→${score}`,
    metricSource(profile, "roe_cv"),
  ];
  if (history[0] < history[history.length - 1] * 0.7) {
    score = capScore(score, 50, "ROE较最早年度下降超过30%，帽50", reasons);
  }
  if (history.length < 5) score = capScore(score, 80, `${history.length}年<5年，帽80`, reasons);
  return { score, value: { history, median: med, stdev: sigma, cv }, reasons };
}

function specialYear(card, i) {
  return (card.special?.years || [])[i] || {};
}

function dimBase(id, weight) {
  return {
    id,
    label: DIM_LABEL[id] || id,
    weight,
    value: null,
    pct: null,
    pct_bucket: null,
    band: null,
    overheat: null,
    score: null,
    usable: false,
    reasons: [],
  };
}

function directDim(id, weight, result) {
  const dim = dimBase(id, weight);
  dim.value = result?.value ?? null;
  dim.score = result?.score ?? null;
  dim.usable = dim.score != null;
  dim.reasons = result?.reasons || ["缺字段"];
  return dim;
}

function applyNumeric({
  id,
  weight,
  value,
  peersValues,
  higherBetter,
  band,
  knots,
  overheat,
  n,
  suspect,
  extraReasons = [],
  displayValue,
}) {
  const d = dimBase(id, weight);
  d.value = displayValue !== undefined ? displayValue : value;
  d.band = band;
  d.overheat = overheat;
  d.reasons.push(...extraReasons);
  if (suspect) {
    d.reasons.push("哨兵未核，该维 —");
    return d;
  }
  if (value == null) {
    d.reasons.push("缺字段");
    return d;
  }
  const xs = (peersValues || []).map(fnum).filter((x) => x != null);
  const nEff = xs.length;
  d.pct = higherBetter ? percentileHigher(value, xs) : percentileLower(value, xs);
  d.pct_bucket = pctToScore(d.pct);
  const fin = finishScore({ pct: d.pct, n: nEff });
  d.score = fin.score;
  d.reasons.push(...fin.reasons);
  if (id === "pay" && fnum(value) != null && fnum(value) > 100) {
    d.score = 0;
    d.reasons.push("派息>100%，该维0，走红线");
  }
  d.usable = d.score != null;
  return d;
}

function finKindOf(card) {
  if (card.f100) return finKindFromF100(card.f100);
  if (card.fin_kind === "bank" || card.fin_kind === "insurance" || card.fin_kind === "broker") {
    return card.fin_kind;
  }
  if (card.special?.kind === "bank" || card.special?.kind === "insurance" || card.special?.kind === "broker") {
    return card.special.kind;
  }
  return "corp";
}

function totalScore(weights, dims) {
  const entries = Object.entries(weights);
  const missing = entries.filter(([id]) => !dims[id]?.usable).map(([id]) => id);
  if (missing.length) return { total: null, rating: "⚠️", missing };
  const total = Math.round(entries.reduce((sum, [id, weight]) => sum + dims[id].score * weight, 0));
  return { total, rating: ratingOf(total), missing: [] };
}

export function scoreCard(card, cards) {
  const kind = finKindOf(card);
  const weights = WEIGHTS[kind] || WEIGHTS.corp;
  const pg = peerGroup(card, cards);
  const n = pg.n;
  const anchors = anchorProfile(card.f100);
  const dims = {};

  const peerVals = (getter) => pg.peers.map(getter);
  const fcf = fcfMetric(card);
  const fcfOk = kind !== "corp" || (fcf.minCover != null && fcf.minCover >= 1);

  dims.pay = applyNumeric({
    id: "pay",
    weight: weights.pay,
    value: fnum(card.pay_ratio),
    peersValues: peerVals((c) => fnum(c.pay_ratio)),
    higherBetter: true,
    band: payBand(card.f100, card.pay_ratio, fcfOk),
    knots: payKnots(card.f100, fcfOk),
    overheat: overheatCap(card.pay_ratio, histPay(card)),
    n,
    suspect: gapHit(card, /派息率踩哨兵/),
  });

  dims.roe = applyNumeric({
    id: "roe",
    weight: weights.roe,
    value: fnum(card.roe3),
    peersValues: peerVals((c) => fnum(c.roe3)),
    higherBetter: true,
    band: roeBand(card.f100, card.roe3),
    knots: roeKnots(card.f100),
    overheat: overheatCap(card.roe3, histRoe(card)),
    n,
    suspect: false,
  });

  dims.dividend_discipline = applyNumeric({
    id: "dividend_discipline",
    weight: weights.dividend_discipline,
    value: dpsCutCount(card),
    peersValues: peerVals(dpsCutCount),
    higherBetter: false,
    n,
    displayValue: dividendDisciplineScore(card.pay_hist).value,
  });

  dims.pb = applyNumeric({
    id: "pb",
    weight: weights.pb,
    value: fnum(card.pb),
    peersValues: peerVals((c) => fnum(c.pb)),
    higherBetter: false,
    band: pbBand(card.f100, card.pb),
    knots: pbKnots(card.f100),
    overheat: null,
    n,
    suspect: false,
  });

  if (kind === "corp") {
    dims.fcf = applyNumeric({
      id: "fcf",
      weight: weights.fcf,
      value: fcf.value,
      peersValues: peerVals((c) => fcfMetric(c).value),
      higherBetter: true,
      band: fcfBand(fcf.value, fcf.minCover),
      knots: fcfKnots(),
      overheat: null,
      n,
      suspect: fcf.suspect,
    });
    if (fcf.minCover != null && fcf.minCover < 1 && dims.fcf.score != null && dims.fcf.score > 50) {
      dims.fcf.score = 50;
      dims.fcf.reasons.push("任一年cover<1，该维最多50");
    }
    dims.debt = applyNumeric({
      id: "debt",
      weight: weights.debt,
      value: fnum(card.debt),
      peersValues: peerVals((c) => fnum(c.debt)),
      higherBetter: false,
      band: debtBand(card.f100, card.debt),
      knots: debtKnots(card.f100),
      overheat: null,
      n,
      suspect: false,
    });
    dims.roic_durability = applyNumeric({
      id: "roic_durability",
      weight: weights.roic_durability,
      value: durabilityMedian(card, "roic_5y"),
      peersValues: peerVals((c) => durabilityMedian(c, "roic_5y")),
      higherBetter: true,
      n,
      displayValue: card.durability_evidence?.roic_5y,
    });
    dims.margin_durability = applyNumeric({
      id: "margin_durability",
      weight: weights.margin_durability,
      value: durabilitySigma(card, "gross_margin_5y") ?? durabilitySigma(card, "net_margin_5y"),
      peersValues: peerVals(
        (c) => durabilitySigma(c, "gross_margin_5y") ?? durabilitySigma(c, "net_margin_5y"),
      ),
      higherBetter: false,
      n,
      displayValue: card.durability_evidence?.gross_margin_5y || card.durability_evidence?.net_margin_5y,
    });
  }

  if (kind === "bank") {
    const y0 = specialYear(card, 0);
    const y1 = specialYear(card, 1);
    const nplD = applyNumeric({
      id: "npl",
      weight: weights.asset,
      value: fnum(y0.npl),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).npl)),
      higherBetter: false,
      band: nplBand(y0.npl),
      knots: nplKnots(),
      overheat: null,
      n,
      suspect: false,
    });
    const provD = applyNumeric({
      id: "provision",
      weight: weights.asset,
      value: fnum(y0.provision),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).provision)),
      higherBetter: true,
      band: provisionBand(y0.provision),
      knots: provisionKnots(),
      overheat: null,
      n,
      suspect: false,
    });
    const asset = dimBase("asset", weights.asset);
    if (nplD.usable && provD.usable) {
      asset.score = Math.round((nplD.score + provD.score) / 2);
      asset.usable = true;
      asset.value = { npl: y0.npl, provision: y0.provision };
      asset.reasons = [`不良档${nplD.score}+拨备档${provD.score}→${asset.score}`];
    } else if (nplD.usable) {
      Object.assign(asset, nplD, { id: "asset", label: DIM_LABEL.asset, weight: weights.asset });
    } else if (provD.usable) {
      Object.assign(asset, provD, { id: "asset", label: DIM_LABEL.asset, weight: weights.asset });
    } else {
      asset.reasons.push("不良/拨备缺字段");
    }
    dims.asset = asset;
    dims.cet1 = applyNumeric({
      id: "cet1",
      weight: weights.cet1,
      value: fnum(y0.cet1),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).cet1)),
      higherBetter: true,
      band: cet1Band(y0.cet1),
      knots: cet1Knots(),
      overheat: null,
      n,
      suspect: false,
    });
    const nim0 = fnum(y0.nim);
    const nim1 = fnum(y1.nim);
    const nimChg = nim0 != null && nim1 != null ? nim0 - nim1 : null;
    dims.nim_trend = applyNumeric({
      id: "nim_trend",
      weight: weights.nim_trend,
      value: nim0,
      peersValues: peerVals((c) => fnum(specialYear(c, 0).nim)),
      higherBetter: true,
      band: nimLevelBand(nim0),
      knots: nimLevelKnots(),
      overheat: null,
      n,
      suspect: false,
      extraReasons: [
        "NIM水平分位",
        nimChg == null ? "缺两年净息差（仅备注）" : `两年变动${nimChg.toFixed(2)}pct（仅备注）`,
      ].filter(Boolean),
    });
    if (dims.nim_trend.usable) dims.nim_trend.value = { nim: nim0, chg: nimChg };
    dims.roe_stability = applyNumeric({
      id: "roe_stability",
      weight: weights.roe_stability,
      value: roeCvOf(card),
      peersValues: peerVals(roeCvOf),
      higherBetter: false,
      n,
      displayValue: {
        history: histRoe(card).slice(0, 5),
        median: median(histRoe(card).slice(0, 5)),
        cv: roeCvOf(card),
      },
    });
  }

  if (kind === "insurance") {
    const y0 = specialYear(card, 0);
    const y1 = specialYear(card, 1);
    dims.solvency = applyNumeric({
      id: "solvency",
      weight: weights.solvency,
      value: fnum(y0.solvency),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).solvency)),
      higherBetter: true,
      band: solvencyBand(y0.solvency),
      knots: solvencyKnots(),
      overheat: null,
      n,
      suspect: false,
    });
    const sol0 = fnum(y0.solvency);
    const sol1 = fnum(y1.solvency);
    const solChg = sol0 != null && sol1 != null ? sol0 - sol1 : null;
    const solPeerChgs = (pg.peers || []).map((c) => {
      const a = fnum(specialYear(c, 0).solvency);
      const b = fnum(specialYear(c, 1).solvency);
      return a != null && b != null ? a - b : null;
    });
    dims.solvency_trend = applyNumeric({
      id: "solvency_trend",
      weight: weights.solvency_trend,
      value: solChg,
      peersValues: solPeerChgs,
      higherBetter: true,
      n,
      displayValue: { current: sol0, prev: sol1, delta: solChg },
    });
    const roi0 = fnum(y0.net_roi);
    const roi1 = fnum(y1.net_roi);
    const roiChg = roi0 != null && roi1 != null ? roi0 - roi1 : null;
    const roiPeerChgs = (pg.peers || []).map((c) => {
      const a = fnum(specialYear(c, 0).net_roi);
      const b = fnum(specialYear(c, 1).net_roi);
      return a != null && b != null ? a - b : null;
    });
    dims.roi_trend = applyNumeric({
      id: "roi_trend",
      weight: weights.roi_trend,
      value: roiChg,
      peersValues: roiPeerChgs,
      higherBetter: true,
      n,
      displayValue: { current: roi0, prev: roi1, delta: roiChg },
    });
    dims.roe_stability = applyNumeric({
      id: "roe_stability",
      weight: weights.roe_stability,
      value: roeCvOf(card),
      peersValues: peerVals(roeCvOf),
      higherBetter: false,
      n,
      displayValue: {
        history: histRoe(card).slice(0, 5),
        median: median(histRoe(card).slice(0, 5)),
        cv: roeCvOf(card),
      },
    });
  }

  if (kind === "broker") {
    dims.debt = applyNumeric({
      id: "debt",
      weight: weights.debt,
      value: fnum(card.debt),
      peersValues: peerVals((c) => fnum(c.debt)),
      higherBetter: false,
      band: debtBand(card.f100, card.debt),
      knots: debtKnots(card.f100),
      overheat: null,
      n,
      suspect: false,
    });
    dims.roe_stability = applyNumeric({
      id: "roe_stability",
      weight: weights.roe_stability,
      value: roeCvOf(card),
      peersValues: peerVals(roeCvOf),
      higherBetter: false,
      n,
      displayValue: {
        history: histRoe(card).slice(0, 5),
        median: median(histRoe(card).slice(0, 5)),
        cv: roeCvOf(card),
      },
    });
  }

  const result = totalScore(weights, dims);
  return {
    kind,
    peer: { key: pg.key, n, escalated: pg.escalated },
    anchors: {
      version: anchors.version,
      f100: anchors.industryKey || null,
      sources: anchors.sources,
      pb_source:
        anchors.metrics.pb?.anchor != null
          ? "f100锚"
          : classPbAnchor(card.f100) != null
            ? "类别软锚"
            : "仅同类分位（PB未校准）",
    },
    dims,
    missing: result.missing,
    numeric_ok: result.missing.length === 0,
    total: result.total,
    rating: result.rating,
  };
}

export function scoreAllCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  return list.map((c) => ({ ...c, score: scoreCard(c, list) }));
}

function eq(got, want, label, fails) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  if (g !== w) fails.push(`${label}: ${g} != ${w}`);
}

export function selfTest() {
  const fails = [];
  eq(pctToScore(80), 80, "pct-80", fails);
  eq(pctToScore(59), 59, "pct-59", fails);
  eq(pctToBucket(59), 59, "pct-bucket-alias", fails);
  eq(linearScore(-0.11, [
    { x: -0.2, y: 0 },
    { x: -0.08, y: 20 },
    { x: 0, y: 50 },
    { x: 0.08, y: 80 },
    { x: 0.2, y: 100 },
  ]), 15, "nim-linear-mid", fails);
  eq(linearScore(150, solvencyKnots()), 50, "solvency-adequate", fails);
  eq(linearScore(180, solvencyKnots()), 80, "solvency-healthy", fails);
  eq(linearScore(193.3, solvencyKnots()), 83, "solvency-pingan-band", fails);
  eq(linearScore(273, solvencyKnots()), 90, "solvency-excess-cap", fails);
  const stPeer = scoreSolvencyTrend(-10.8, [-10.8, 17, -7.08]);
  eq(stPeer.score, 61, "solvency-trend-vs-peer-pingan", fails);
  const stSolo = scoreSolvencyTrend(-11, [-11]);
  eq(stSolo.score, 47, "solvency-trend-own-fallback", fails);
  const stPack = scoreSolvencyTrend(-20, [-20, -20, -20, -20]);
  eq(stPack.score, 70, "solvency-trend-sector-drop-flat", fails);
  eq(snapGrade(70), 80, "snap-70", fails);
  eq(snapGrade(65), 50, "snap-65-tie-down", fails);

  const xs = [8, 9.5, 11, 14];
  eq(Math.round(percentileHigher(14, xs)), 100, "pctile-best", fails);
  eq(Math.round(percentileHigher(8, xs)), 0, "pctile-worst", fails);
  eq(Math.round(percentileHigher(10, [10, 10, 10, 10])), 50, "pctile-tie-mid", fails);

  eq(roeBand("水力发电", 14).zone, "excellent", "roe-exc", fails);
  eq(roeBand("水力发电", 9).zone, "good", "roe-good", fails);
  eq(roeBand("水力发电", 6).zone, "ok", "roe-ok", fails);
  eq(fcfBand(1.2, 1.2).max, 80, "fcf-good-cap80", fails);
  eq(fcfBand(1.8, 0.6).max, 50, "fcf-min-cover-cap", fails);
  eq(payBand("水力发电", 120, true).zone, "red>100", "pay-red", fails);
  eq(payBand("水力发电", 85, true).zone, "healthy", "pay-wide-ok", fails);
  eq(payBand("水力发电", 92, true).zone, "high-ok", "pay-above-ok", fails);

  const hot = overheatCap(22, [6, 7, 8, 5, 9, 7, 6]);
  eq(hot.cap, 50, "overheat-2x", fails);
  const elevated = overheatCap(12, [8, 8.5, 9, 7.5, 8, 9]);
  eq(elevated.cap, 80, "overheat-1.3-and-own-high", fails);
  const stable = overheatCap(13, [12, 13, 14, 12, 13, 14]);
  eq(stable.cap, null, "overheat-stable", fails);
  const tightHigh = overheatCap(13.5, [14, 13, 13.5, 12.8, 12.2, 12]);
  eq(tightHigh.cap, null, "overheat-tight-band", fails);

  const small = finishScore({ pct: 100, n: 1 });
  eq(small.score, 50, "n<2-neutral50", fails);

  const passthrough = finishScore({ pct: 87.3, n: 6 });
  eq(passthrough.score, 87, "pct-passthrough", fails);

  const d100 = finishScore({ pct: 100, n: 6 });
  eq(d100.score, 100, "top-peer-pct", fails);

  const durable = {
    roic_5y: {
      history: [12, 11.5, 11, 10.5, 10].map((value, i) => ({ year: String(2025 - i), value })),
      n: 5,
      median: 11,
      stdev: 0.71,
    },
    gross_margin_5y: {
      history: [40, 39.5, 40.5, 39, 40].map((value, i) => ({ year: String(2025 - i), value })),
      n: 5,
      median: 40,
      stdev: 0.51,
    },
  };
  const disciplined = [1, 0.95, 0.9, 0.85, 0.8].map((dps, i) => ({
    year: String(2025 - i),
    dps,
    pay_pct: 55 + i,
  }));
  const cards = [
    { code: "1", f100: "水力发电", roe3: 14, pay_ratio: 70, pb: 2.0, debt: 50, fcf_cov: [{ cover: 1.6 }] },
    { code: "2", f100: "水力发电", roe3: 11, pay_ratio: 65, pb: 2.2, debt: 55, fcf_cov: [{ cover: 1.3 }] },
    { code: "3", f100: "水力发电", roe3: 9, pay_ratio: 60, pb: 2.4, debt: 58, fcf_cov: [{ cover: 1.1 }] },
    { code: "4", f100: "水力发电", roe3: 8, pay_ratio: 55, pb: 1.8, debt: 48, fcf_cov: [{ cover: 1.2 }] },
    { code: "5", f100: "水力发电", roe3: 7.5, pay_ratio: 52, pb: 1.6, debt: 45, fcf_cov: [{ cover: 1.0 }] },
  ].map((card) => ({
    ...card,
    durability_evidence: durable,
    pay_hist: disciplined,
    roe_hist: [0, 1, 2, 3, 4].map((i) => ({ year: String(2025 - i), roe: card.roe3 - i * 0.1 })),
  }));
  const g = peerGroup(cards[0], cards);
  eq(g.escalated, false, "hydro-no-escalate", fails);
  eq(g.n, 5, "hydro-f100-n", fails);
  const s = scoreCard(cards[0], cards);
  if (!s.numeric_ok) fails.push("hydro-numeric-ok");
  if (s.dims.roe.score < 80) fails.push(`top-hydro-roe ${s.dims.roe.score}`);
  if (s.total == null || s.rating === "⚠️") fails.push("fully-numeric-total");
  if (s.dims.roic_durability.score == null || s.dims.margin_durability.score == null) {
    fails.push("corp-durability-missing");
  }

  const weakFcf = scoreCard(
    { ...cards[0], fcf_cov: [{ cover: 0.4 }, { cover: 0.5 }] },
    cards,
  );
  if (weakFcf.dims.fcf.score > 20) fails.push(`weak-fcf-cap ${weakFcf.dims.fcf.score}`);

  const bankBase = {
    f100: "银行Ⅱ",
    fin_kind: "bank",
    roe3: 10,
    pay_ratio: 32,
    pb: 0.65,
    pay_hist: disciplined,
    roe_hist: [10, 10.2, 9.8, 10.1, 9.9].map((roe, i) => ({ year: String(2025 - i), roe })),
    special: {
      kind: "bank",
      years: [
        { npl: 1.0, provision: 220, cet1: 12, nim: 1.8 },
        { npl: 1.05, provision: 210, cet1: 11.8, nim: 1.78 },
      ],
    },
  };
  const banks = [1, 2, 3, 4].map((i) => ({ ...bankBase, code: `b${i}`, pb: 0.6 + i * 0.03 }));
  const bankScore = scoreCard(banks[0], banks);
  if (!bankScore.numeric_ok || bankScore.total == null) fails.push(`bank-full-score ${JSON.stringify(bankScore.missing)}`);
  if (!bankScore.dims.roe_stability?.usable || Object.keys(bankScore.dims).length !== 8) {
    fails.push("bank-eight-numeric-dimensions");
  }
  if (bankScore.dims.nim_trend.score !== 50) fails.push(`bank-nim-tied ${bankScore.dims.nim_trend.score}`);
  if (bankScore.dims.pb.score < 50) fails.push(`bank-pb-class-band ${bankScore.dims.pb.score}`);
  eq(nimTrendCap(-0.11, [-0.14, -0.13, -0.12, -0.1]).cap, null, "nim-inline-no-cap", fails);
  eq(nimTrendCap(-0.21, [-0.1, -0.11, -0.12, -0.09]).cap, 20, "nim-idio-hard", fails);
  eq(nimTrendCap(-0.12, [-0.04, -0.03, -0.05, -0.02]).cap, 80, "nim-idio-mild", fails);

  const insuranceBase = {
    f100: "保险Ⅱ",
    fin_kind: "insurance",
    roe3: 11,
    pay_ratio: 30,
    pb: 0.75,
    pay_hist: disciplined,
    roe_hist: [11, 10.8, 11.2, 10.7, 11.1].map((roe, i) => ({ year: String(2025 - i), roe })),
    special: {
      kind: "insurance",
      years: [
        { solvency: 220, net_roi: 4.5 },
        { solvency: 215, net_roi: 4.4 },
      ],
    },
  };
  const insurers = [1, 2, 3, 4].map((i) => ({ ...insuranceBase, code: `i${i}`, pb: 0.7 + i * 0.03 }));
  const insW = Object.values(WEIGHTS.insurance).reduce((s, w) => s + w, 0);
  if (Math.abs(insW - 1) > 1e-9) fails.push(`insurance-weights-sum ${insW}`);
  const insuranceScore = scoreCard(insurers[0], insurers);
  if (!insuranceScore.numeric_ok || insuranceScore.total == null) {
    fails.push(`insurance-full-score ${JSON.stringify(insuranceScore.missing)}`);
  }

  const brokerBase = {
    f100: "证券",
    roe3: 8.5,
    pay_ratio: 32,
    pb: 1.05,
    debt: 78,
    pay_hist: disciplined,
    roe_hist: [8.5, 8.2, 8.0, 8.3, 8.1].map((roe, i) => ({ year: String(2025 - i), roe })),
  };
  const brokers = [1, 2, 3, 4].map((i) => ({ ...brokerBase, code: `s${i}`, pb: 0.95 + i * 0.04, debt: 76 + i }));
  const brokerScore = scoreCard(brokers[0], brokers);
  if (brokerScore.kind !== "broker") fails.push(`broker-kind ${brokerScore.kind}`);
  if (brokerScore.dims.fcf) fails.push("broker-must-not-use-fcf");
  if (!brokerScore.numeric_ok || brokerScore.total == null) {
    fails.push(`broker-full-score ${JSON.stringify(brokerScore.missing)}`);
  }
  const sniffBank = scoreCard({ ...brokerBase, code: "sniff", special: { kind: "bank", years: [{ npl: 1 }] } }, brokers);
  if (sniffBank.kind !== "broker") fails.push(`broker-f100-beats-npl ${sniffBank.kind}`);

  const moutaiPb = pbBand("白酒Ⅱ", 6.68);
  if (!moutaiPb || moutaiPb.source !== "class") {
    fails.push(`baijiu-pb-class ${JSON.stringify(moutaiPb)}`);
  }
  const noAnchorPb = pbBand("半导体", 6.68);
  if (!noAnchorPb || noAnchorPb.source !== "class" || noAnchorPb.max !== 0) {
    fails.push(`chip-pb-class-expensive ${JSON.stringify(noAnchorPb)}`);
  }

  const liquor = [
    { code: "600519", f100: "白酒Ⅱ", roe3: 34, pay_ratio: 79, pb: 6.68, debt: 16, fcf_cov: [{ cover: 1.1 }, { cover: 1.3 }] },
    { code: "000858", f100: "白酒Ⅱ", roe3: 18, pay_ratio: 70, pb: 2.43, debt: 36, fcf_cov: [{ cover: 1.4 }, { cover: 1.4 }] },
    { code: "000568", f100: "白酒Ⅱ", roe3: 29, pay_ratio: 78, pb: 2.55, debt: 30, fcf_cov: [{ cover: 1.2 }, { cover: 1.1 }] },
    { code: "600809", f100: "白酒Ⅱ", roe3: 38, pay_ratio: 65, pb: 4.07, debt: 25, fcf_cov: [{ cover: 1.0 }, { cover: 1.2 }] },
  ].map((card) => ({
    ...card,
    durability_evidence: {
      ...durable,
      roic_5y: {
        ...durable.roic_5y,
        history: [24, 23, 22, 21, 20].map((value, i) => ({ year: String(2025 - i), value })),
        median: 22,
      },
    },
    pay_hist: disciplined,
    roe_hist: [0, 1, 2, 3, 4].map((i) => ({ year: String(2025 - i), roe: card.roe3 - i * 0.2 })),
  }));
  const ms = scoreCard(liquor[0], liquor);
  const wy = scoreCard(liquor[1], liquor);
  if (ms.dims.pb.score == null || wy.dims.pb.score == null) fails.push("liquor-pb-missing");
  if (wy.dims.pb.score <= ms.dims.pb.score) fails.push(`pb-peer-rank wy=${wy.dims.pb.score} ms=${ms.dims.pb.score}`);
  const pg = peerGroup(liquor[0], liquor);
  if (pg.key !== "f100:白酒" || pg.n !== 4) fails.push(`baijiu-peer ${pg.key} n=${pg.n}`);

  return fails;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["selfTest", "self-test"] });
  if (!(args.selfTest || args["self-test"])) {
    console.error("usage: node score_numeric.js --self-test");
    return 1;
  }
  const fails = selfTest();
  if (fails.length) {
    console.error(`self-test FAIL ${fails.length}`);
    for (const f of fails) console.error(`  ${f}`);
    return 1;
  }
  console.log("self-test OK");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
