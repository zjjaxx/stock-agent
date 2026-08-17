#!/usr/bin/env node
/**
 * Step 2 全量数字评分：同类分位 + 宽带宽 + 自身历史 + 持久性。
 * 不定红线终评、不写桌面终报。
 *
 * 用法: node score_numeric.js --self-test
 */

import { parseArgs } from "./opencli_json.js";
import { anchorProfile, metricSource } from "./anchor_config.js";

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
    solvency: 0.25,
    solvency_trend: 0.14,
    pay: 0.15,
    roe: 0.1,
    roi_trend: 0.1,
    pb: 0.1,
    dividend_discipline: 0.09,
    roe_stability: 0.07,
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
  nim_trend: "净息差趋势",
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

/** 含自身；n<2 无法分位。越高越好：严格更差的同伴 / (n-1)。 */
export function percentileHigher(value, peersInclSelf) {
  const v = fnum(value);
  const xs = (peersInclSelf || []).map(fnum).filter((x) => x != null);
  if (v == null || xs.length < 2) return null;
  const worse = xs.filter((x) => x < v).length;
  return (worse / (xs.length - 1)) * 100;
}

export function percentileLower(value, peersInclSelf) {
  const v = fnum(value);
  const xs = (peersInclSelf || []).map(fnum).filter((x) => x != null);
  if (v == null || xs.length < 2) return null;
  const worse = xs.filter((x) => x > v).length;
  return (worse / (xs.length - 1)) * 100;
}

export function pctToBucket(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 80) return 100;
  if (pct >= 60) return 80;
  if (pct >= 40) return 50;
  if (pct >= 20) return 20;
  return 0;
}

export function ratingOf(total) {
  if (total == null || !Number.isFinite(total)) return "⚠️";
  if (total >= 80) return "🟢";
  if (total >= 70) return "🟡";
  if (total >= 60) return "🟠";
  return "🔴";
}

/** 同类仅同一东财 f100；n<4 则不用分位、不给 100。 */
export function peerGroup(card, cards) {
  const f100 = normF100(card.f100);
  if (!f100) return { peers: [], key: "f100:", n: 0, escalated: false };
  const peers = (cards || []).filter((c) => normF100(c.f100) === f100);
  return { peers, key: `f100:${f100}`, n: peers.length, escalated: false };
}

export function roeBand(f100, roe) {
  const v = fnum(roe);
  if (v == null) return null;
  const a = fnum(anchorProfile(f100).metrics.roe?.anchor);
  if (a == null) return null;
  if (v >= a + 4) return { min: 80, max: 100, zone: "excellent" };
  if (v >= a) return { min: 50, max: 80, zone: "good" };
  if (v >= a - 3) return { min: 20, max: 50, zone: "ok" };
  if (v >= a - 5) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

export function pbBand(f100, pb) {
  const v = fnum(pb);
  if (v == null || v <= 0) return null;
  const p = fnum(anchorProfile(f100).metrics.pb?.anchor);
  if (p == null) return { min: 0, max: 100, zone: "peer-only-no-pb-anchor" };
  if (v <= p * 0.6) return { min: 80, max: 100, zone: "excellent" };
  if (v <= p) return { min: 50, max: 80, zone: "good" };
  if (v <= p * 1.4) return { min: 20, max: 50, zone: "ok" };
  if (v <= p * 2) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

export function debtBand(f100, debt) {
  const v = fnum(debt);
  if (v == null) return null;
  const d = fnum(anchorProfile(f100).metrics.debt?.anchor);
  if (d == null) return null;
  if (v <= d - 15) return { min: 80, max: 100, zone: "excellent" };
  if (v <= d) return { min: 50, max: 80, zone: "good" };
  if (v <= d + 10) return { min: 20, max: 50, zone: "ok" };
  if (v <= d + 20) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

/** minCover<1 → 再高也最多 50（差的里面第一仍盖不住分红）。 */
export function fcfBand(cover, minCover) {
  const v = fnum(cover);
  if (v == null) return null;
  let band;
  if (v >= 1.5) band = { min: 80, max: 100, zone: "excellent" };
  else if (v >= 1.0) band = { min: 50, max: 80, zone: "good" };
  else if (v >= 0.8) band = { min: 20, max: 50, zone: "ok" };
  else if (v >= 0.5) band = { min: 0, max: 20, zone: "weak" };
  else band = { min: 0, max: 0, zone: "bad" };
  if (fnum(minCover) != null && minCover < 1) {
    band = { ...band, max: Math.min(band.max, 50), zone: `${band.zone}|cover<1` };
  }
  return band;
}

export function payBand(f100, pay, fcfOk) {
  const v = fnum(pay);
  if (v == null) return null;
  if (v > 100) return { min: 0, max: 0, zone: "red>100" };
  const band = anchorProfile(f100).metrics.pay?.band;
  if (!band) return null;
  const [lo, hi] = band;
  const wlo = Math.max(0, lo - 10);
  const whi = hi + 10;
  if (v >= wlo && v <= whi) return { min: 50, max: 100, zone: "healthy" };
  if (v > whi) {
    return fcfOk
      ? { min: 50, max: 80, zone: "high-ok" }
      : { min: 20, max: 50, zone: "high-weak" };
  }
  if (v >= wlo - 10) return { min: 20, max: 50, zone: "low" };
  return { min: 0, max: 20, zone: "very-low" };
}

export function nplBand(npl) {
  const v = fnum(npl);
  if (v == null) return null;
  if (v <= 0.9) return { min: 80, max: 100, zone: "excellent" };
  if (v <= 1.5) return { min: 50, max: 80, zone: "good" };
  if (v <= 2.0) return { min: 20, max: 50, zone: "ok" };
  if (v <= 3.0) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

export function provisionBand(prov) {
  const v = fnum(prov);
  if (v == null) return null;
  if (v >= 250) return { min: 80, max: 100, zone: "excellent" };
  if (v >= 180) return { min: 50, max: 80, zone: "good" };
  if (v >= 150) return { min: 20, max: 50, zone: "ok" };
  if (v >= 120) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

export function cet1Band(cet1) {
  const v = fnum(cet1);
  if (v == null) return null;
  if (v >= 13) return { min: 80, max: 100, zone: "excellent" };
  if (v >= 11) return { min: 50, max: 80, zone: "good" };
  if (v >= 9.5) return { min: 20, max: 50, zone: "ok" };
  if (v >= 8) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
}

export function solvencyBand(sol) {
  const v = fnum(sol);
  if (v == null) return null;
  if (v >= 250) return { min: 80, max: 100, zone: "excellent" };
  if (v >= 180) return { min: 50, max: 80, zone: "good" };
  if (v >= 150) return { min: 20, max: 50, zone: "ok" };
  if (v >= 120) return { min: 0, max: 20, zone: "weak" };
  return { min: 0, max: 0, zone: "bad" };
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
  if (chg >= 0.08) return { score: 80, zone: "up" };
  if (chg >= -0.08) return { score: 50, zone: "flat" };
  if (chg >= -0.2) return { score: 20, zone: "down" };
  return { score: 0, zone: "down-hard" };
}

export function relTrendScore(newer, older) {
  const a = fnum(newer);
  const b = fnum(older);
  if (a == null || b == null || b === 0) return { score: null, zone: "missing" };
  const rel = (a - b) / Math.abs(b);
  if (rel >= 0.05) return { score: 80, zone: "up" };
  if (rel >= -0.05) return { score: 50, zone: "flat" };
  if (rel >= -0.15) return { score: 20, zone: "down" };
  return { score: 0, zone: "down-hard" };
}

/**
 * n≥4：分位档夹进带宽。
 * n<4：不用分位，取带宽下沿（不给 100）。
 * 过热帽最后压一档。
 */
export function finishScore({ pctBucket, band, n, overheat }) {
  if (!band) return { score: null, reasons: [] };
  const reasons = [];
  let score;
  if (n < MIN_PEER) {
    score = band.min;
    reasons.push(`样本n=${n}<${MIN_PEER}，不用分位，带宽下沿${score}`);
  } else if (pctBucket == null) {
    score = band.min;
    reasons.push(`分位不足，带宽下沿${score}`);
  } else {
    score = Math.min(band.max, Math.max(band.min, pctBucket));
    reasons.push(`分位档${pctBucket}夹带宽[${band.min},${band.max}]→${score}`);
  }
  const cap = overheat?.cap;
  if (cap != null && cap < score) {
    reasons.push(`过热帽${cap}${overheat.reason ? `(${overheat.reason})` : ""}`);
    score = cap;
  }
  return { score, reasons };
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
  const [cv80, cv50, cv20] = roicMetric.cv_cuts || [0.3, 0.5, 0.75];
  let score = med >= anchor * 1.5 ? 100 : med >= anchor ? 80 : med >= anchor * 0.7 ? 50 : med >= anchor * 0.4 ? 20 : 0;
  const reasons = [
    `${history.length}年中位${med.toFixed(2)}%，f100锚${anchor}%→${score}`,
    metricSource(profile, "roic"),
  ];
  const sigma = fnum(summary?.stdev) ?? stdev(history);
  const cv = sigma == null || Math.abs(med) < 0.01 ? null : sigma / Math.abs(med);
  if (cv != null) {
    if (cv > cv20) score = capScore(score, 20, `波动CV=${cv.toFixed(2)}>${cv20}，帽20`, reasons);
    else if (cv > cv50) score = capScore(score, 50, `波动CV=${cv.toFixed(2)}>${cv50}，帽50`, reasons);
    else if (cv > cv80) score = capScore(score, 80, `波动CV=${cv.toFixed(2)}>${cv80}，帽80`, reasons);
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
  let score = sigma <= c100 ? 100 : sigma <= c80 ? 80 : sigma <= c50 ? 50 : sigma <= c20 ? 20 : 0;
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
  let score = cuts === 0 ? 100 : cuts === 1 ? 50 : cuts === 2 ? 20 : 0;
  const paySigma = stdev(rows.map((row) => row.pay_pct));
  const reasons = [`DPS下调${cuts}次→${score}`];
  if (paySigma != null) {
    if (paySigma > 30) score = capScore(score, 20, `派息率波动σ=${paySigma.toFixed(1)}pct，帽20`, reasons);
    else if (paySigma > 20) score = capScore(score, 50, `派息率波动σ=${paySigma.toFixed(1)}pct，帽50`, reasons);
    else if (paySigma > 10) score = capScore(score, 80, `派息率波动σ=${paySigma.toFixed(1)}pct，帽80`, reasons);
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
  let score = cv <= c100 ? 100 : cv <= c80 ? 80 : cv <= c50 ? 50 : cv <= c20 ? 20 : 0;
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
  overheat,
  n,
  suspect,
  extraReasons = [],
}) {
  const d = dimBase(id, weight);
  d.value = value;
  d.band = band;
  d.overheat = overheat;
  d.reasons.push(...extraReasons);
  if (suspect) {
    d.reasons.push("哨兵未核，该维 —");
    return d;
  }
  if (value == null || !band) {
    d.reasons.push("缺字段");
    return d;
  }
  d.pct = higherBetter ? percentileHigher(value, peersValues) : percentileLower(value, peersValues);
  d.pct_bucket = pctToBucket(d.pct);
  const fin = finishScore({ pctBucket: d.pct_bucket, band, n, overheat });
  d.score = fin.score;
  d.reasons.push(...fin.reasons);
  d.usable = d.score != null;
  return d;
}

function finKindOf(card) {
  if (card.fin_kind === "bank" || card.fin_kind === "insurance") return card.fin_kind;
  if (card.special?.kind === "bank" || card.special?.kind === "insurance") return card.special.kind;
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
    overheat: overheatCap(card.roe3, histRoe(card)),
    n,
    suspect: false,
  });

  dims.dividend_discipline = directDim(
    "dividend_discipline",
    weights.dividend_discipline,
    dividendDisciplineScore(card.pay_hist),
  );

  dims.pb = applyNumeric({
    id: "pb",
    weight: weights.pb,
    value: fnum(card.pb),
    peersValues: peerVals((c) => fnum(c.pb)),
    higherBetter: false,
    band: pbBand(card.f100, card.pb),
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
      overheat: null,
      n,
      suspect: fcf.suspect,
    });
    dims.debt = applyNumeric({
      id: "debt",
      weight: weights.debt,
      value: fnum(card.debt),
      peersValues: peerVals((c) => fnum(c.debt)),
      higherBetter: false,
      band: debtBand(card.f100, card.debt),
      overheat: null,
      n,
      suspect: false,
    });
    dims.roic_durability = directDim(
      "roic_durability",
      weights.roic_durability,
      roicDurabilityScore(card.durability_evidence?.roic_5y, card.f100),
    );
    dims.margin_durability = directDim(
      "margin_durability",
      weights.margin_durability,
      marginDurabilityScore(card.durability_evidence?.gross_margin_5y, card.f100),
    );
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
      overheat: null,
      n,
      suspect: false,
    });
    const asset = dimBase("asset", weights.asset);
    if (nplD.usable && provD.usable) {
      asset.score = snapGrade((nplD.score + provD.score) / 2);
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
      overheat: null,
      n,
      suspect: false,
    });
    const nim = nimTrendScore(y0.nim, y1.nim);
    dims.nim_trend = {
      ...dimBase("nim_trend", weights.nim_trend),
      value: y0.nim != null && y1.nim != null ? y0.nim - y1.nim : null,
      score: nim.score,
      usable: nim.score != null,
      reasons: [nim.zone === "missing" ? "净息差趋势缺两年" : `趋势${nim.zone}`],
    };
    dims.roe_stability = directDim(
      "roe_stability",
      weights.roe_stability,
      roeStabilityScore(histRoe(card), card.f100),
    );
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
      overheat: null,
      n,
      suspect: false,
    });
    const st = relTrendScore(y0.solvency, y1.solvency);
    dims.solvency_trend = {
      ...dimBase("solvency_trend", weights.solvency_trend),
      value: y0.solvency != null && y1.solvency != null ? y0.solvency - y1.solvency : null,
      score: st.score,
      usable: st.score != null,
      reasons: [st.zone === "missing" ? "偿付趋势缺两年" : `趋势${st.zone}`],
    };
    const rt = relTrendScore(y0.net_roi, y1.net_roi);
    dims.roi_trend = {
      ...dimBase("roi_trend", weights.roi_trend),
      value: y0.net_roi != null && y1.net_roi != null ? y0.net_roi - y1.net_roi : null,
      score: rt.score,
      usable: rt.score != null,
      reasons: [rt.zone === "missing" ? "投资收益趋势缺两年" : `趋势${rt.zone}`],
    };
    dims.roe_stability = directDim(
      "roe_stability",
      weights.roe_stability,
      roeStabilityScore(histRoe(card), card.f100),
    );
  }

  const result = totalScore(weights, dims);
  return {
    kind,
    peer: { key: pg.key, n, escalated: pg.escalated },
    anchors: {
      version: anchors.version,
      f100: anchors.industryKey || null,
      sources: anchors.sources,
      pb_source: anchors.metrics.pb?.anchor != null ? "f100锚" : "仅同类分位（PB未校准）",
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
  eq(pctToBucket(80), 100, "pct-80", fails);
  eq(pctToBucket(59), 50, "pct-59", fails);
  eq(snapGrade(70), 80, "snap-70", fails);
  eq(snapGrade(65), 50, "snap-65-tie-down", fails);

  const xs = [8, 9.5, 11, 14];
  eq(Math.round(percentileHigher(14, xs)), 100, "pctile-best", fails);
  eq(Math.round(percentileHigher(8, xs)), 0, "pctile-worst", fails);
  eq(Math.round(percentileLower(0.6, [0.6, 0.8, 1.2, 1.5])), 100, "pctile-low-best", fails);

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

  const small = finishScore({
    pctBucket: 100,
    band: { min: 80, max: 100, zone: "excellent" },
    n: 3,
    overheat: { cap: null },
  });
  eq(small.score, 80, "n<4-no-100", fails);

  const clamped = finishScore({
    pctBucket: 0,
    band: { min: 50, max: 80, zone: "good" },
    n: 6,
    overheat: { cap: null },
  });
  eq(clamped.score, 50, "band-floor", fails);

  const peak = finishScore({
    pctBucket: 100,
    band: { min: 80, max: 100, zone: "excellent" },
    n: 6,
    overheat: { cap: 80, reason: "过热" },
  });
  eq(peak.score, 80, "overheat-after-pct", fails);

  const d100 = finishScore({
    pctBucket: 100,
    band: { min: 80, max: 100, zone: "excellent" },
    n: 6,
    overheat: { cap: null },
  });
  eq(d100.score, 100, "D-stable-can-100", fails);

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
  const insuranceScore = scoreCard(insurers[0], insurers);
  if (!insuranceScore.numeric_ok || insuranceScore.total == null) {
    fails.push(`insurance-full-score ${JSON.stringify(insuranceScore.missing)}`);
  }

  const moutaiPb = pbBand("白酒Ⅱ", 6.68);
  if (!moutaiPb || moutaiPb.max < 20) fails.push(`baijiu-pb-band ${JSON.stringify(moutaiPb)}`);
  const wuliangyePb = pbBand("白酒Ⅱ", 2.43);
  if (!wuliangyePb || wuliangyePb.min < 80) fails.push(`baijiu-pb-cheap ${JSON.stringify(wuliangyePb)}`);
  const noAnchorPb = pbBand("半导体", 6.68);
  if (!noAnchorPb || noAnchorPb.zone !== "peer-only-no-pb-anchor") {
    fails.push(`pb-peer-only ${JSON.stringify(noAnchorPb)}`);
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
  if (ms.dims.pb.score === 0) fails.push("moutai-pb-not-zero");
  if (ms.dims.pb.score == null) fails.push("moutai-pb-missing");
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
