#!/usr/bin/env node
/**
 * Step 2 全量数字评分：硬筛通过池 M 内同一 f100 分位为主尺。
 * n=1（或该维有效同行 <2）：改用自身历史分位；历史有效年数 <3 → 该维缺维 → 整票 ⚠️。
 * 绝对值 knot / 过热帽不进得分；红线仍走 red_hints。无外部校准锚。
 *
 * 用法: node score_numeric.js --self-test
 */

import { parseArgs } from "./opencli_json.js";
import { classPbAnchor, finKindFromF100, isCorpCashKind } from "./industry_map.js";

export const GRADES = [0, 20, 50, 80, 100];
export const MIN_PEER = 4;
export const OVERHEAT_MIN_YEARS = 5;
export const SELF_HIST_MIN_YEARS = 3;

export const WEIGHTS = {
  /** 非金兜底（未命中专有模板）：去 FCF/派息霸权 */
  corp: {
    ocf_quality: 0.15,
    roic_durability: 0.12,
    margin_durability: 0.1,
    dividend_discipline: 0.12,
    div_yield: 0.12,
    roe: 0.12,
    earnings_growth: 0.05,
    pe: 0.08,
    pb: 0.07,
    debt: 0.07,
  },
  /** 白电：品牌护城河 + 渠道/库存排雷 + 现金回报 */
  appliance: {
    margin_durability: 0.12,
    roic_durability: 0.12,
    roe: 0.1,
    contract_liab_trend: 0.1,
    inventory_days: 0.06,
    receivables: 0.05,
    ocf_quality: 0.1,
    div_yield: 0.1,
    dividend_discipline: 0.08,
    dps_growth: 0.05,
    gm_trend: 0.04,
    pe: 0.05,
    debt: 0.03,
  },
  /** 轨交/工程机械/商用车/汽零：订单蓄水 + 回款 + 杠杆 */
  equip_mfg: {
    ocf_quality: 0.12,
    interest_cover: 0.08,
    net_leverage: 0.06,
    receivables: 0.08,
    contract_liab_trend: 0.1,
    roic_durability: 0.12,
    margin_durability: 0.08,
    earnings_growth: 0.08,
    div_yield: 0.08,
    dividend_discipline: 0.1,
    pe: 0.05,
    pb: 0.05,
  },
  /** 安防/通信设备等科技硬件：ROIC/毛利 + 增长 + PE */
  tech_hardware: {
    roic_durability: 0.14,
    margin_durability: 0.12,
    roe: 0.1,
    ocf_quality: 0.1,
    receivables: 0.08,
    inventory_days: 0.06,
    earnings_growth: 0.1,
    contract_liab_trend: 0.06,
    div_yield: 0.06,
    dividend_discipline: 0.08,
    pe: 0.1,
  },
  /** 电力/公路/运营商等类债高股息：优化表≈90%放大至100%；去派息/工业负债/FCF霸权 */
  utility: {
    div_yield: 0.17,
    dividend_discipline: 0.12,
    dps_growth: 0.06,
    roic_durability: 0.14,
    margin_durability: 0.09,
    interest_cover: 0.11,
    receivables: 0.06,
    ocf_quality: 0.12,
    earnings_growth: 0.06,
    /** 无 EV/EBITDA 字段，暂用 PB 池内分位 */
    pb: 0.07,
  },
  /** 白酒/乳品/调味：护城河 + 渠道排雷；去派息/FCF 霸权 */
  brand_consumer: {
    margin_durability: 0.15,
    roic_durability: 0.12,
    roe: 0.1,
    /** 合同负债同比（含原渠道库存位并入） */
    contract_liab_trend: 0.1,
    receivables: 0.05,
    ocf_quality: 0.08,
    div_yield: 0.08,
    dividend_discipline: 0.08,
    dps_growth: 0.05,
    /** 净利 3 年 CAGR */
    earnings_growth: 0.05,
    /** 毛利变动 pp≈吨价/结构代理 */
    gm_trend: 0.05,
    /** 无 PE 年史：池内 PE 分位（越低越好） */
    pe: 0.05,
    debt: 0.04,
  },
  /** 煤炭/炼化/航运等：防顶部幻觉；无商品价/AISC 时用毛利分位与成本代理 */
  resource_cycle: {
    /** 毛利率自身历史分位（越高越热→越警惕）；含原供需位 */
    cycle_heat: 0.17,
    /** 5年毛利中位≈成本曲线位置（含储量权并入） */
    gm_level: 0.15,
    interest_cover: 0.05,
    /** 有息负债率代理净负债/EBITDA */
    net_leverage: 0.08,
    dividend_discipline: 0.12,
    capex_discipline: 0.05,
    roic_durability: 0.15,
    margin_durability: 0.05,
    /** 无个股 PB 年史：池内分位越低越好（防顶部） */
    pb: 0.1,
    /** 无利息绝对额：经营现金流/净利作付息能力代理 */
    ocf_quality: 0.08,
  },
  /** 建筑基建：重回款与杠杆；无新签/地产敞口时用合同资产与应收同比代理 */
  infra_construction: {
    ocf_quality: 0.15,
    receivables: 0.1,
    interest_cover: 0.08,
    net_leverage: 0.05,
    /** 应收/票据同比增速，越高越警惕（地产敞口/坏账压力代理） */
    ar_pressure: 0.05,
    /** 合同资产同比（无新签订单字段） */
    order_proxy: 0.12,
    /** 合同资产/营收≈在手工作量覆盖 */
    backlog_cover: 0.05,
    div_yield: 0.08,
    dividend_discipline: 0.1,
    roic_durability: 0.08,
    gm_trend: 0.05,
    pe: 0.04,
    pb: 0.05,
  },
  bank: {
    asset: 0.1,
    npl_formation: 0.1,
    cet1: 0.1,
    npl_gap: 0.05,
    div_yield: 0.1,
    dividend_discipline: 0.15,
    roe: 0.1,
    roe_stability: 0.1,
    nim_trend: 0.1,
    nonint: 0.05,
    pb: 0.05,
  },
  insurance: {
    /** 按优化表×4/3 取整：偿付 13%（充足+趋势/IRR位） */
    solvency: 0.09,
    solvency_trend: 0.04,
    /** 负债/成长：NBV 增速 + NBV 率（营运利润/EV 替代） */
    nbv_growth: 0.13,
    nbv_margin: 0.07,
    div_yield: 0.13,
    dividend_discipline: 0.07,
    /** 去掉派息；ROE + 净/总投资 + 稳定性 */
    roe: 0.13,
    net_roi: 0.07,
    total_roi: 0.06,
    roe_stability: 0.07,
    /** PB 7% + 无 P/EV 时并入的 7% */
    pb: 0.14,
  },
  broker: {
    /** 优化表≈78%×100/78 取整；无市占/资管拆分时用收入同比与占比代理 */
    risk_coverage: 0.13,
    capital_leverage: 0.1,
    pledge_cover: 0.06,
    div_yield: 0.06,
    roe: 0.13,
    roe_stability: 0.06,
    /** 两融：利息收入同比（无市占字段） */
    margin_growth: 0.1,
    /** 自营：投资收益同比（无投资收益率字段） */
    prop_growth: 0.09,
    /** 经纪等基本盘：手续费/营收；投行/资管趋势并入手续费同比 */
    fee_share: 0.1,
    fee_growth: 0.09,
    /** 无个股 PB 年史，池内分位（越低越好）近似历史分位 */
    pb: 0.08,
  },
};

export const DIM_LABEL = {
  fcf: "FCF覆盖",
  pay: "派息",
  div_yield: "股息率",
  roe: "ROE(3年)",
  pb: "PB",
  debt: "负债率",
  asset: "资产质量",
  cet1: "核充率",
  npl_formation: "不良生成",
  npl_gap: "偏离度",
  nonint: "非息占比",
  nim_trend: "净息差趋势",
  solvency: "偿付充足",
  solvency_trend: "偿付趋势",
  nbv_growth: "NBV增速",
  nbv_margin: "NBV率",
  net_roi: "净投资收益",
  total_roi: "总投资收益",
  roi_trend: "投资收益趋势",
  risk_coverage: "风险覆盖率",
  capital_leverage: "资本杠杆率",
  pledge_cover: "质押保障",
  margin_growth: "两融利息增速",
  prop_growth: "自营投资增速",
  fee_share: "手续费占比",
  fee_growth: "手续费增速",
  dps_growth: "股息增长",
  interest_cover: "利息保障",
  receivables: "应收周转",
  ocf_quality: "经营现金流质量",
  earnings_growth: "盈利增速",
  contract_liab_trend: "合同负债趋势",
  gm_trend: "毛利趋势",
  pe: "PE",
  inventory_days: "存货周转",
  ar_pressure: "应收膨胀",
  order_proxy: "合同资产增速",
  backlog_cover: "合同资产覆盖",
  cycle_heat: "周期热度",
  gm_level: "毛利水平",
  net_leverage: "有息杠杆",
  capex_discipline: "资本开支纪律",
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

/** 展示用：缺口 ⚠️；有总分则「第k/n」（须先 assignPeerRanks）。 */
export function formatPeerRank(score) {
  if (!score || score.total == null || score.numeric_ok === false) return "⚠️";
  if (score.rank != null && score.rank_n != null) return `第${score.rank}/${score.rank_n}`;
  return "—";
}

/** @deprecated 颜色档已删除。缺口 ⚠️，其余不再上色。 */
export function ratingOf(total) {
  if (total == null || !Number.isFinite(Number(total))) return "⚠️";
  return "—";
}

/** 同类仅同一东财 f100（样本=硬筛通过池 M）。n≥2 用同行分位；否则自身历史。 */
export function peerGroup(card, cards) {
  const f100 = normF100(card.f100);
  if (!f100) return { peers: [], key: "f100:", n: 0, escalated: false };
  const peers = (cards || []).filter((c) => normF100(c.f100) === f100);
  return { peers, key: `f100:${f100}`, n: peers.length, escalated: false };
}

export function roeKnots(_f100) {
  // 对照用软带（不进得分）；已取消 f100 校准锚
  return null;
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
  const p = classPbAnchor(f100);
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
  return { ...band, zone, source: "class" };
}

export function debtKnots(_f100) {
  return null;
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

export function payKnots(_f100, _fcfOk) {
  return null;
}

export function payBand(_f100, pay, _fcfOk) {
  const v = fnum(pay);
  if (v == null) return null;
  if (v > 100) return { min: 0, max: 0, zone: "red>100" };
  return { min: 0, max: 100, zone: "peer-pct" };
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
 * 只按分位打分（0–100）。绝对值 knot / 过热帽不进得分。
 * mode=peer：池内同行；mode=self：自身历史。
 */
export function finishScore({ pct, n, mode = "peer" }) {
  const score = pctToScore(pct);
  if (score == null) return { score: null, reasons: ["分位不足"] };
  const nn = Number(n) || 0;
  if (mode === "self") {
    return { score, reasons: [`自身历史分位${score}（年数=${nn}）`] };
  }
  return { score, reasons: [`同类分位${score}（n=${nn}）`] };
}

/** 自身历史序列：须含当前值；不足 SELF_HIST_MIN_YEARS 返回 []。 */
export function selfHistSeries(current, histVals) {
  const v = fnum(current);
  const hist = (histVals || []).map(fnum).filter((x) => x != null);
  if (v == null) return [];
  let xs = hist.slice();
  if (!xs.length) xs = [v];
  else if (!xs.some((x) => x === v)) xs = [v, ...xs];
  return xs;
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

export function roicDurabilityScore(summary, _f100 = "") {
  const history = (summary?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (history.length < 3) return { score: null, value: summary || null, reasons: ["ROIC历史不足3年"] };
  const med = fnum(summary?.median) ?? median(history);
  return {
    score: null,
    value: summary,
    reasons: [`ROIC中位${med == null ? "—" : med.toFixed(2)}%（得分改走池内同类分位）`],
  };
}

export function marginDurabilityScore(summary, _f100 = "") {
  const history = (summary?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (history.length < 3) return { score: null, value: summary || null, reasons: ["毛利率历史不足3年"] };
  const sigma = fnum(summary?.stdev) ?? stdev(history);
  return {
    score: null,
    value: summary,
    reasons: [`毛利率σ=${sigma == null ? "—" : sigma.toFixed(2)}pct（得分改走池内同类分位）`],
  };
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

export function roeStabilityScore(values, _f100 = "") {
  const history = (values || []).map(fnum).filter((x) => x != null).slice(0, 5);
  if (history.length < 3) return { score: null, value: { history }, reasons: ["ROE历史不足3年"] };
  const med = median(history);
  if (med == null || med <= 0) return { score: 0, value: { history, median: med }, reasons: ["ROE中位≤0"] };
  const sigma = stdev(history);
  const cv = sigma / med;
  return {
    score: null,
    value: { history, median: med, stdev: sigma, cv },
    reasons: [`ROE CV=${cv.toFixed(2)}（得分改走池内同类分位）`],
  };
}

function specialYear(card, i) {
  return (card.special?.years || [])[i] || {};
}

/** 不良净生成率%：（本期不良余额−上期）/上期贷款。缺绝对额时退回不良率变动（百分点）。 */
export function nplFormationPct(card) {
  const y0 = specialYear(card, 0);
  const y1 = specialYear(card, 1);
  const a = fnum(y0.npl_amt);
  const b = fnum(y1.npl_amt);
  const denom = fnum(y1.gross_loans) > 0 ? fnum(y1.gross_loans) : fnum(y0.gross_loans);
  if (a != null && b != null && denom > 0) return ((a - b) / denom) * 100;
  const r0 = fnum(y0.npl);
  const r1 = fnum(y1.npl);
  if (r0 != null && r1 != null) return r0 - r1;
  return null;
}

/** 偏离度%：逾期贷款/不良余额。东财 OVERDUE_LOANS，非严格「逾期90天以上」。 */
export function nplGapPct(card) {
  const y0 = specialYear(card, 0);
  const overdue = fnum(y0.overdue_loans);
  const nplAmt = fnum(y0.npl_amt);
  if (overdue == null || !(nplAmt > 0)) return null;
  return (overdue / nplAmt) * 100;
}

/** 寿险 NBV 同比增速%：（本期 NBV − 上期）/上期。 */
export function nbvGrowthPct(card) {
  const y0 = specialYear(card, 0);
  const y1 = specialYear(card, 1);
  const a = fnum(y0.nbv);
  const b = fnum(y1.nbv);
  if (a == null || b == null || !(Math.abs(b) > 0)) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function specialMetric(card, key, yearIndex = 0) {
  return fnum(specialYear(card, yearIndex)[key]);
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
  selfHistValues,
}) {
  const d = dimBase(id, weight);
  d.value = displayValue !== undefined ? displayValue : value;
  d.band = band;
  d.overheat = overheat;
  d.score_mode = null;
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
  if (nEff >= 2) {
    d.pct = higherBetter ? percentileHigher(value, xs) : percentileLower(value, xs);
    d.pct_bucket = pctToScore(d.pct);
    const fin = finishScore({ pct: d.pct, n: nEff, mode: "peer" });
    d.score = fin.score;
    d.score_mode = "peer";
    d.reasons.push(...fin.reasons);
  } else {
    const series = selfHistSeries(value, selfHistValues);
    if (series.length < SELF_HIST_MIN_YEARS) {
      d.reasons.push(
        `同类有效n=${nEff}<2且自身历史有效年数${series.length}<${SELF_HIST_MIN_YEARS}→缺维`,
      );
      d.usable = false;
      return d;
    }
    d.pct = higherBetter ? percentileHigher(value, series) : percentileLower(value, series);
    d.pct_bucket = pctToScore(d.pct);
    const fin = finishScore({ pct: d.pct, n: series.length, mode: "self" });
    d.score = fin.score;
    d.score_mode = "self_hist";
    d.reasons.push(...fin.reasons);
  }
  if (id === "pay" && fnum(value) != null && fnum(value) > 100) {
    d.score = 0;
    d.reasons.push("派息>100%，该维0，走红线");
  }
  d.usable = d.score != null;
  return d;
}

function finKindOf(card) {
  if (card.f100) return finKindFromF100(card.f100);
  if (card.fin_kind) return card.fin_kind;
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
  return { total, rating: null, missing: [] };
}


function annualValues(summary) {
  return (summary?.history || []).map((row) => fnum(row.value)).filter((x) => x != null);
}

function fcfCoverHist(card) {
  return (card.fcf_cov || []).map((r) => fnum(r.cover)).filter((x) => x != null);
}

function dpsHist(card) {
  return (card.pay_hist || [])
    .map((row) => fnum(row.dps))
    .filter((x) => x != null && x > 0)
    .slice(0, 5);
}

/** 最近两年 DPS 同比增速%。 */
export function dpsGrowthPct(card) {
  const rows = (card.pay_hist || [])
    .map((row) => ({ year: row.year, dps: fnum(row.dps) }))
    .filter((row) => row.dps != null && row.dps > 0)
    .slice(0, 3);
  if (rows.length < 2) return null;
  const a = rows[0].dps;
  const b = rows[1].dps;
  if (!(b > 0)) return null;
  return ((a - b) / b) * 100;
}

/** 经营现金流/净利润（最新年报）；>1 通常更健康。 */
export function ocfNiRatio(card) {
  const row = (card.fcf_cov || [])[0] || {};
  const ocf = fnum(row.ocf);
  const profit = fnum(row.profit);
  if (ocf == null || !(profit > 0)) return null;
  return ocf / profit;
}

/** 营收/净利同比均值（有一个则用一个）。 */
export function earningsGrowthPct(card) {
  const y0 = specialYear(card, 0);
  const rev = fnum(y0.rev_yoy);
  const prof = fnum(y0.profit_yoy);
  if (rev != null && prof != null) return (rev + prof) / 2;
  return rev ?? prof ?? null;
}

/**
 * 周期热度 0–100：最新毛利率在自身近 5 年中的分位（越高越接近景气顶）。
 * 无商品价格分位时的代理。
 */
export function cycleHeatPct(card) {
  const hist = annualValues(card.durability_evidence?.gross_margin_5y);
  if (hist.length < 3) return null;
  const latest = hist[0];
  return percentileHigher(latest, hist);
}

/** 资本开支/经营现金流（越高越偏扩张，越差）。 */
export function capexOcfRatio(card) {
  const row = (card.fcf_cov || [])[0] || {};
  const ocf = fnum(row.ocf);
  const capex = fnum(row.capex);
  if (!(ocf > 0) || capex == null) return null;
  return capex / ocf;
}

/** 归母净利近 3 年 CAGR%。 */
export function profitCagr3(card) {
  const profits = (card.fcf_cov || [])
    .map((row) => fnum(row.profit))
    .filter((x) => x != null && x > 0)
    .slice(0, 3);
  if (profits.length < 3) return null;
  const latest = profits[0];
  const old = profits[2];
  if (!(old > 0)) return null;
  return (Math.pow(latest / old, 1 / 2) - 1) * 100;
}

/** 毛利率年变动（百分点）；吨价/产品结构代理。 */
export function gmTrendPp(card) {
  const hist = annualValues(card.durability_evidence?.gross_margin_5y);
  if (hist.length < 2) return null;
  return hist[0] - hist[1];
}

/** 经营现金流/营收；无营收则退回 OCF/净利。 */
export function ocfRevenueRatio(card) {
  const row = (card.fcf_cov || [])[0] || {};
  const ocf = fnum(row.ocf);
  const rev = fnum(specialYear(card, 0).operate_reve);
  if (ocf != null && rev > 0) return ocf / rev;
  return ocfNiRatio(card);
}

/** 合同资产/营收（在手工作量覆盖代理）。 */
export function backlogCoverRatio(card) {
  const y0 = specialYear(card, 0);
  const ca = fnum(y0.contract_asset);
  const rev = fnum(y0.operate_reve);
  if (ca == null || !(rev > 0)) return null;
  return ca / rev;
}

function specialSeries(card, key) {
  return (card.special?.years || []).map((y) => fnum(y[key])).filter((x) => x != null);
}

export function scoreCard(card, cards) {
  const kind = finKindOf(card);
  const weights = WEIGHTS[kind] || WEIGHTS.corp;
  const pg = peerGroup(card, cards);
  const n = pg.n;
  const dims = {};

  const peerVals = (getter) => pg.peers.map(getter);
  const fcf = fcfMetric(card);
  const fcfOk = !isCorpCashKind(kind) || (fcf.minCover != null && fcf.minCover >= 1);

  if (weights.pay != null) {
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
      selfHistValues: histPay(card),
    });
  }

  if (weights.div_yield != null) {
    dims.div_yield = applyNumeric({
      id: "div_yield",
      weight: weights.div_yield,
      value: fnum(card.div),
      peersValues: peerVals((c) => fnum(c.div)),
      higherBetter: true,
      n,
      suspect: false,
      selfHistValues: [], // 无逐年 TTM 股息序列；同业 n≥2 走分位
      extraReasons: ["TTM股息率同业分位（门槛之上仍奖励更厚垫）"],
    });
  }

  if (weights.roe != null) {
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
      selfHistValues: histRoe(card),
    });
  }

  if (weights.dividend_discipline != null) {
    dims.dividend_discipline = applyNumeric({
      id: "dividend_discipline",
      weight: weights.dividend_discipline,
      value: dpsCutCount(card),
      peersValues: peerVals(dpsCutCount),
      higherBetter: false,
      n,
      displayValue: dividendDisciplineScore(card.pay_hist).value,
      selfHistValues: [], // 下调次数无逐年序列；n=1 且无同行 → 缺维
    });
  }

  if (weights.pb != null) {
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
      selfHistValues: [], // 无 PB 年史；n=1 → 缺维
    });
  }
  if (weights.pe != null) {
    dims.pe = applyNumeric({
      id: "pe",
      weight: weights.pe,
      value: fnum(card.pe),
      peersValues: peerVals((c) => fnum(c.pe)),
      higherBetter: false,
      n,
      suspect: false,
      selfHistValues: [],
      extraReasons: ["PE(TTM)池内分位（无个股历史分位；越低越好）"],
    });
  }
  if (isCorpCashKind(kind)) {
    if (weights.fcf != null) {
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
        selfHistValues: fcfCoverHist(card),
      });
      if (fcf.minCover != null && fcf.minCover < 1 && dims.fcf.score != null && dims.fcf.score > 50) {
        dims.fcf.score = 50;
        dims.fcf.reasons.push("任一年cover<1，该维最多50");
      }
    }
    if (weights.debt != null) {
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
        selfHistValues: [], // 无负债率年史；n=1 → 缺维
      });
    }
    if (weights.roic_durability != null) {
      dims.roic_durability = applyNumeric({
        id: "roic_durability",
        weight: weights.roic_durability,
        value: durabilityMedian(card, "roic_5y"),
        peersValues: peerVals((c) => durabilityMedian(c, "roic_5y")),
        higherBetter: true,
        n,
        displayValue: card.durability_evidence?.roic_5y,
        selfHistValues: annualValues(card.durability_evidence?.roic_5y),
      });
    }
    if (weights.margin_durability != null) {
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
        selfHistValues: [],
      });
    }
  }

  if (kind === "utility") {
    const y0 = specialYear(card, 0);
    dims.dps_growth = applyNumeric({
      id: "dps_growth",
      weight: weights.dps_growth,
      value: dpsGrowthPct(card),
      peersValues: peerVals(dpsGrowthPct),
      higherBetter: true,
      n,
      displayValue: { growth_pct: dpsGrowthPct(card), dps: dpsHist(card).slice(0, 3) },
      extraReasons: ["近两年 DPS 同比增速"],
    });
    dims.interest_cover = applyNumeric({
      id: "interest_cover",
      weight: weights.interest_cover,
      value: fnum(y0.interest_cover),
      peersValues: peerVals((c) => specialMetric(c, "interest_cover")),
      higherBetter: true,
      n,
      extraReasons: ["利息保障倍数（优先于资产负债率）"],
    });
    dims.receivables = applyNumeric({
      id: "receivables",
      weight: weights.receivables,
      value: fnum(y0.ar_days),
      peersValues: peerVals((c) => specialMetric(c, "ar_days")),
      higherBetter: false,
      n,
      displayValue: { ar_days: y0.ar_days },
      extraReasons: ["应收账款周转天数 YSZKZZTS（越低越好）"],
    });
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      extraReasons: ["经营现金流/净利润（替代 FCF 覆盖霸权）"],
    });
    dims.earnings_growth = applyNumeric({
      id: "earnings_growth",
      weight: weights.earnings_growth,
      value: earningsGrowthPct(card),
      peersValues: peerVals(earningsGrowthPct),
      higherBetter: true,
      n,
      displayValue: { rev_yoy: y0.rev_yoy, profit_yoy: y0.profit_yoy, blended: earningsGrowthPct(card) },
      extraReasons: ["营收同比与归母净利同比均值"],
    });
  }

  if (kind === "brand_consumer") {
    const y0 = specialYear(card, 0);
    dims.dps_growth = applyNumeric({
      id: "dps_growth",
      weight: weights.dps_growth,
      value: dpsGrowthPct(card),
      peersValues: peerVals(dpsGrowthPct),
      higherBetter: true,
      n,
      displayValue: { growth_pct: dpsGrowthPct(card), dps: dpsHist(card).slice(0, 3) },
      extraReasons: ["近两年 DPS 同比增速"],
    });
    dims.contract_liab_trend = applyNumeric({
      id: "contract_liab_trend",
      weight: weights.contract_liab_trend,
      value: fnum(y0.contract_liab_yoy),
      peersValues: peerVals((c) => specialMetric(c, "contract_liab_yoy")),
      higherBetter: true,
      n,
      displayValue: {
        contract_liab: y0.contract_liab,
        contract_liab_yoy: y0.contract_liab_yoy,
      },
      selfHistValues: specialSeries(card, "contract_liab_yoy"),
      extraReasons: ["合同负债同比 CONTRACT_LIAB_YOY（渠道打款领先指标；无社会库存）"],
    });
    dims.receivables = applyNumeric({
      id: "receivables",
      weight: weights.receivables,
      value: fnum(y0.ar_days),
      peersValues: peerVals((c) => specialMetric(c, "ar_days")),
      higherBetter: false,
      n,
      displayValue: { ar_days: y0.ar_days },
      selfHistValues: specialSeries(card, "ar_days"),
      extraReasons: ["应收账款周转天数（信用政策是否放水）"],
    });
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const profit = fnum(row.profit);
          return ocf != null && profit > 0 ? ocf / profit : null;
        })
        .filter((x) => x != null),
      extraReasons: ["经营现金流/净利润"],
    });
    dims.earnings_growth = applyNumeric({
      id: "earnings_growth",
      weight: weights.earnings_growth,
      value: profitCagr3(card) ?? earningsGrowthPct(card),
      peersValues: peerVals((c) => profitCagr3(c) ?? earningsGrowthPct(c)),
      higherBetter: true,
      n,
      displayValue: {
        cagr3: profitCagr3(card),
        yoy_blend: earningsGrowthPct(card),
        rev_yoy: specialYear(card, 0).rev_yoy,
        profit_yoy: specialYear(card, 0).profit_yoy,
      },
      extraReasons: ["归母净利 3 年 CAGR；不足则用营收/净利同比均值"],
    });
    dims.gm_trend = applyNumeric({
      id: "gm_trend",
      weight: weights.gm_trend,
      value: gmTrendPp(card),
      peersValues: peerVals(gmTrendPp),
      higherBetter: true,
      n,
      displayValue: {
        delta_pp: gmTrendPp(card),
        gm_hist: card.durability_evidence?.gross_margin_5y,
      },
      extraReasons: ["毛利率年变动（吨价/产品结构代理；无吨价字段）"],
    });
  }

  if (kind === "appliance" || kind === "tech_hardware") {
    const y0 = specialYear(card, 0);
    dims.contract_liab_trend = applyNumeric({
      id: "contract_liab_trend",
      weight: weights.contract_liab_trend,
      value: fnum(y0.contract_liab_yoy),
      peersValues: peerVals((c) => specialMetric(c, "contract_liab_yoy")),
      higherBetter: true,
      n,
      displayValue: { contract_liab_yoy: y0.contract_liab_yoy },
      selfHistValues: specialSeries(card, "contract_liab_yoy"),
      extraReasons: ["合同负债同比（渠道/预收蓄水）"],
    });
    dims.receivables = applyNumeric({
      id: "receivables",
      weight: weights.receivables,
      value: fnum(y0.ar_days),
      peersValues: peerVals((c) => specialMetric(c, "ar_days")),
      higherBetter: false,
      n,
      displayValue: { ar_days: y0.ar_days },
      selfHistValues: specialSeries(card, "ar_days"),
      extraReasons: ["应收账款周转天数"],
    });
    dims.inventory_days = applyNumeric({
      id: "inventory_days",
      weight: weights.inventory_days,
      value: fnum(y0.inv_days),
      peersValues: peerVals((c) => specialMetric(c, "inv_days")),
      higherBetter: false,
      n,
      displayValue: { inv_days: y0.inv_days },
      selfHistValues: specialSeries(card, "inv_days"),
      extraReasons: ["存货周转天数 CHZZTS（越高越警惕）"],
    });
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const profit = fnum(row.profit);
          return ocf != null && profit > 0 ? ocf / profit : null;
        })
        .filter((x) => x != null),
      extraReasons: ["经营现金流/净利润"],
    });
    if (weights.dps_growth != null) {
      dims.dps_growth = applyNumeric({
        id: "dps_growth",
        weight: weights.dps_growth,
        value: dpsGrowthPct(card),
        peersValues: peerVals(dpsGrowthPct),
        higherBetter: true,
        n,
        displayValue: { growth_pct: dpsGrowthPct(card), dps: dpsHist(card).slice(0, 3) },
        extraReasons: ["近两年 DPS 同比增速"],
      });
    }
    if (weights.gm_trend != null) {
      dims.gm_trend = applyNumeric({
        id: "gm_trend",
        weight: weights.gm_trend,
        value: gmTrendPp(card),
        peersValues: peerVals(gmTrendPp),
        higherBetter: true,
        n,
        displayValue: { delta_pp: gmTrendPp(card) },
        selfHistValues: (() => {
          const hist = annualValues(card.durability_evidence?.gross_margin_5y);
          const out = [];
          for (let i = 0; i < hist.length - 1; i++) out.push(hist[i] - hist[i + 1]);
          return out;
        })(),
        extraReasons: ["毛利率年变动"],
      });
    }
    if (weights.earnings_growth != null) {
      dims.earnings_growth = applyNumeric({
        id: "earnings_growth",
        weight: weights.earnings_growth,
        value: profitCagr3(card) ?? earningsGrowthPct(card),
        peersValues: peerVals((c) => profitCagr3(c) ?? earningsGrowthPct(c)),
        higherBetter: true,
        n,
        displayValue: {
          cagr3: profitCagr3(card),
          yoy_blend: earningsGrowthPct(card),
        },
        extraReasons: ["归母净利 3 年 CAGR；不足则用营收/净利同比均值"],
      });
    }
  }

  if (kind === "equip_mfg") {
    const y0 = specialYear(card, 0);
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const profit = fnum(row.profit);
          return ocf != null && profit > 0 ? ocf / profit : null;
        })
        .filter((x) => x != null),
      extraReasons: ["经营现金流/净利润"],
    });
    dims.interest_cover = applyNumeric({
      id: "interest_cover",
      weight: weights.interest_cover,
      value: fnum(y0.interest_cover),
      peersValues: peerVals((c) => specialMetric(c, "interest_cover")),
      higherBetter: true,
      n,
      selfHistValues: specialSeries(card, "interest_cover"),
      extraReasons: ["利息保障倍数"],
    });
    dims.net_leverage = applyNumeric({
      id: "net_leverage",
      weight: weights.net_leverage,
      value: fnum(y0.interest_debt) ?? fnum(card.debt),
      peersValues: peerVals((c) => specialMetric(c, "interest_debt") ?? fnum(c.debt)),
      higherBetter: false,
      n,
      selfHistValues: specialSeries(card, "interest_debt"),
      extraReasons: ["有息负债率"],
    });
    dims.receivables = applyNumeric({
      id: "receivables",
      weight: weights.receivables,
      value: fnum(y0.ar_days),
      peersValues: peerVals((c) => specialMetric(c, "ar_days")),
      higherBetter: false,
      n,
      displayValue: { ar_days: y0.ar_days },
      selfHistValues: specialSeries(card, "ar_days"),
      extraReasons: ["应收账款周转天数"],
    });
    dims.contract_liab_trend = applyNumeric({
      id: "contract_liab_trend",
      weight: weights.contract_liab_trend,
      value: fnum(y0.contract_liab_yoy),
      peersValues: peerVals((c) => specialMetric(c, "contract_liab_yoy")),
      higherBetter: true,
      n,
      displayValue: { contract_liab_yoy: y0.contract_liab_yoy },
      selfHistValues: specialSeries(card, "contract_liab_yoy"),
      extraReasons: ["合同负债同比（订单/预收代理）"],
    });
    dims.earnings_growth = applyNumeric({
      id: "earnings_growth",
      weight: weights.earnings_growth,
      value: profitCagr3(card) ?? earningsGrowthPct(card),
      peersValues: peerVals((c) => profitCagr3(c) ?? earningsGrowthPct(c)),
      higherBetter: true,
      n,
      displayValue: {
        cagr3: profitCagr3(card),
        yoy_blend: earningsGrowthPct(card),
      },
      extraReasons: ["归母净利 3 年 CAGR；不足则用营收/净利同比均值"],
    });
  }

  if (kind === "corp") {
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const profit = fnum(row.profit);
          return ocf != null && profit > 0 ? ocf / profit : null;
        })
        .filter((x) => x != null),
      extraReasons: ["经营现金流/净利润（兜底模板）"],
    });
    dims.earnings_growth = applyNumeric({
      id: "earnings_growth",
      weight: weights.earnings_growth,
      value: profitCagr3(card) ?? earningsGrowthPct(card),
      peersValues: peerVals((c) => profitCagr3(c) ?? earningsGrowthPct(c)),
      higherBetter: true,
      n,
      displayValue: {
        cagr3: profitCagr3(card),
        yoy_blend: earningsGrowthPct(card),
      },
      extraReasons: ["归母净利 3 年 CAGR；不足则用营收/净利同比均值"],
    });
  }

  if (kind === "infra_construction") {
    const y0 = specialYear(card, 0);
    const ocfRevHist = (card.special?.years || [])
      .map((y, i) => {
        const rev = fnum(y.operate_reve);
        const row = (card.fcf_cov || [])[i] || {};
        const ocf = fnum(row.ocf);
        if (ocf != null && rev > 0) return ocf / rev;
        const profit = fnum(row.profit);
        return ocf != null && profit > 0 ? ocf / profit : null;
      })
      .filter((x) => x != null);
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfRevenueRatio(card),
      peersValues: peerVals(ocfRevenueRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        revenue: y0.operate_reve,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfRevenueRatio(card),
      },
      selfHistValues: ocfRevHist,
      extraReasons: ["经营现金流/营收（无营收则退回 OCF/净利）"],
    });
    dims.receivables = applyNumeric({
      id: "receivables",
      weight: weights.receivables,
      value: fnum(y0.ar_days),
      peersValues: peerVals((c) => specialMetric(c, "ar_days")),
      higherBetter: false,
      n,
      displayValue: { ar_days: y0.ar_days },
      selfHistValues: specialSeries(card, "ar_days"),
      extraReasons: ["应收账款周转天数"],
    });
    dims.interest_cover = applyNumeric({
      id: "interest_cover",
      weight: weights.interest_cover,
      value: fnum(y0.interest_cover),
      peersValues: peerVals((c) => specialMetric(c, "interest_cover")),
      higherBetter: true,
      n,
      selfHistValues: specialSeries(card, "interest_cover"),
      extraReasons: ["利息保障倍数"],
    });
    dims.net_leverage = applyNumeric({
      id: "net_leverage",
      weight: weights.net_leverage,
      value: fnum(y0.interest_debt) ?? fnum(card.debt),
      peersValues: peerVals((c) => specialMetric(c, "interest_debt") ?? fnum(c.debt)),
      higherBetter: false,
      n,
      selfHistValues: specialSeries(card, "interest_debt"),
      extraReasons: ["有息负债率（有息负债/净资产约束代理）"],
    });
    dims.ar_pressure = applyNumeric({
      id: "ar_pressure",
      weight: weights.ar_pressure,
      value: fnum(y0.ar_yoy),
      peersValues: peerVals((c) => specialMetric(c, "ar_yoy")),
      higherBetter: false,
      n,
      displayValue: { ar_yoy: y0.ar_yoy, note_rece_yoy: y0.note_rece_yoy },
      selfHistValues: specialSeries(card, "ar_yoy"),
      extraReasons: ["应收/票据同比（越高越警惕；地产敞口/坏账压力代理）"],
    });
    dims.order_proxy = applyNumeric({
      id: "order_proxy",
      weight: weights.order_proxy,
      value: fnum(y0.contract_asset_yoy),
      peersValues: peerVals((c) => specialMetric(c, "contract_asset_yoy")),
      higherBetter: true,
      n,
      displayValue: {
        contract_asset_yoy: y0.contract_asset_yoy,
        contract_liab_yoy: y0.contract_liab_yoy,
      },
      selfHistValues: specialSeries(card, "contract_asset_yoy"),
      extraReasons: ["合同资产同比（无新签订单字段时的订单/施工蓄水代理）"],
    });
    const backlogHist = (card.special?.years || [])
      .map((y) => {
        const ca = fnum(y.contract_asset);
        const rev = fnum(y.operate_reve);
        return ca != null && rev > 0 ? ca / rev : null;
      })
      .filter((x) => x != null);
    dims.backlog_cover = applyNumeric({
      id: "backlog_cover",
      weight: weights.backlog_cover,
      value: backlogCoverRatio(card),
      peersValues: peerVals(backlogCoverRatio),
      higherBetter: true,
      n,
      displayValue: {
        contract_asset: y0.contract_asset,
        operate_reve: y0.operate_reve,
        cover: backlogCoverRatio(card),
      },
      selfHistValues: backlogHist,
      extraReasons: ["合同资产/营收（在手工作量覆盖代理）"],
    });
    dims.gm_trend = applyNumeric({
      id: "gm_trend",
      weight: weights.gm_trend,
      value: gmTrendPp(card),
      peersValues: peerVals(gmTrendPp),
      higherBetter: true,
      n,
      displayValue: { delta_pp: gmTrendPp(card), gm_hist: card.durability_evidence?.gross_margin_5y },
      selfHistValues: (() => {
        const hist = annualValues(card.durability_evidence?.gross_margin_5y);
        const out = [];
        for (let i = 0; i < hist.length - 1; i++) out.push(hist[i] - hist[i + 1]);
        return out;
      })(),
      extraReasons: ["毛利率年变动（薄利行业看趋势）"],
    });
  }

  if (kind === "resource_cycle") {
    const y0 = specialYear(card, 0);
    dims.cycle_heat = applyNumeric({
      id: "cycle_heat",
      weight: weights.cycle_heat,
      value: cycleHeatPct(card),
      peersValues: peerVals(cycleHeatPct),
      higherBetter: false,
      n,
      displayValue: {
        heat: cycleHeatPct(card),
        gm_hist: card.durability_evidence?.gross_margin_5y,
      },
      extraReasons: ["毛利率自身历史分位代理商品价格分位（越高越警惕顶部）"],
      selfHistValues: [], // 热度已是自身分位；n=1 仍可与单点比较→不足则缺维
    });
    // n=1：热度本身 0–100，直接映射得分，避免无同行时整票⚠️
    if (!dims.cycle_heat.usable && cycleHeatPct(card) != null) {
      const heat = cycleHeatPct(card);
      dims.cycle_heat.score = pctToScore(100 - heat);
      dims.cycle_heat.usable = true;
      dims.cycle_heat.score_mode = "abs_invert";
      dims.cycle_heat.reasons.push(`n=1 热度${heat.toFixed?.(0) ?? heat}→得分${dims.cycle_heat.score}`);
    }
    dims.gm_level = applyNumeric({
      id: "gm_level",
      weight: weights.gm_level,
      value: durabilityMedian(card, "gross_margin_5y"),
      peersValues: peerVals((c) => durabilityMedian(c, "gross_margin_5y")),
      higherBetter: true,
      n,
      displayValue: card.durability_evidence?.gross_margin_5y,
      selfHistValues: annualValues(card.durability_evidence?.gross_margin_5y),
      extraReasons: ["5年毛利中位代理成本曲线位置（无 AISC/储量）"],
    });
    dims.interest_cover = applyNumeric({
      id: "interest_cover",
      weight: weights.interest_cover,
      value: fnum(y0.interest_cover) ?? fnum(card.interest_cover),
      peersValues: peerVals(
        (c) => specialMetric(c, "interest_cover") ?? fnum(c.interest_cover),
      ),
      higherBetter: true,
      n,
      selfHistValues: specialSeries(card, "interest_cover"),
      extraReasons: ["利息保障倍数"],
    });
    dims.net_leverage = applyNumeric({
      id: "net_leverage",
      weight: weights.net_leverage,
      value: fnum(y0.interest_debt) ?? fnum(card.debt),
      peersValues: peerVals(
        (c) => specialMetric(c, "interest_debt") ?? fnum(c.debt),
      ),
      higherBetter: false,
      n,
      displayValue: { interest_debt: y0.interest_debt, debt: card.debt },
      selfHistValues: specialSeries(card, "interest_debt"),
      extraReasons: ["有息负债率 INTEREST_DEBT_RATIO（无净负债/EBITDA 时代理）"],
    });
    dims.capex_discipline = applyNumeric({
      id: "capex_discipline",
      weight: weights.capex_discipline,
      value: capexOcfRatio(card),
      peersValues: peerVals(capexOcfRatio),
      higherBetter: false,
      n,
      displayValue: {
        capex: (card.fcf_cov || [])[0]?.capex,
        ocf: (card.fcf_cov || [])[0]?.ocf,
        ratio: capexOcfRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const capex = fnum(row.capex);
          return ocf > 0 && capex != null ? capex / ocf : null;
        })
        .filter((x) => x != null),
      extraReasons: ["资本开支/经营现金流（越高越偏顶部扩张）"],
    });
    dims.ocf_quality = applyNumeric({
      id: "ocf_quality",
      weight: weights.ocf_quality,
      value: ocfNiRatio(card),
      peersValues: peerVals(ocfNiRatio),
      higherBetter: true,
      n,
      displayValue: {
        ocf: (card.fcf_cov || [])[0]?.ocf,
        profit: (card.fcf_cov || [])[0]?.profit,
        ratio: ocfNiRatio(card),
      },
      selfHistValues: (card.fcf_cov || [])
        .map((row) => {
          const ocf = fnum(row.ocf);
          const profit = fnum(row.profit);
          return ocf != null && profit > 0 ? ocf / profit : null;
        })
        .filter((x) => x != null),
      extraReasons: ["经营现金流/净利润（无 OCF/利息绝对额时的付息能力代理）"],
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
    dims.npl_formation = applyNumeric({
      id: "npl_formation",
      weight: weights.npl_formation,
      value: nplFormationPct(card),
      peersValues: peerVals(nplFormationPct),
      higherBetter: false,
      n,
      suspect: false,
      extraReasons: ["不良净生成（Δ不良余额/期初贷款；缺核销口径）"],
    });
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
    dims.npl_gap = applyNumeric({
      id: "npl_gap",
      weight: weights.npl_gap,
      value: nplGapPct(card),
      peersValues: peerVals(nplGapPct),
      higherBetter: false,
      n,
      suspect: false,
      extraReasons: ["逾期/不良（东财 OVERDUE_LOANS，非严格90天）"],
    });
    const nim0 = fnum(y0.nim);
    const nim1 = fnum(y1.nim);
    const nimChg = nim0 != null && nim1 != null ? nim0 - nim1 : null;
    dims.nim_trend = applyNumeric({
      id: "nim_trend",
      weight: weights.nim_trend,
      value: nimChg,
      peersValues: peerVals((c) => {
        const a = fnum(specialYear(c, 0).nim);
        const b = fnum(specialYear(c, 1).nim);
        return a != null && b != null ? a - b : null;
      }),
      higherBetter: true,
      n,
      suspect: false,
      extraReasons: [
        "NIM两年变动分位（收窄越少/扩张越好）",
        nim0 == null ? "缺最新NIM（仅备注）" : `最新NIM ${nim0.toFixed(2)}%（仅备注，不进分）`,
      ].filter(Boolean),
    });
    if (dims.nim_trend.usable || nim0 != null) {
      dims.nim_trend.value = { nim: nim0, chg: nimChg };
    }
    dims.nonint = applyNumeric({
      id: "nonint",
      weight: weights.nonint,
      value: fnum(y0.nonint_ratio),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).nonint_ratio)),
      higherBetter: true,
      n,
      suspect: false,
      extraReasons: ["非息=1−利息净收入/营业总收入"],
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
    dims.nbv_growth = applyNumeric({
      id: "nbv_growth",
      weight: weights.nbv_growth,
      value: nbvGrowthPct(card),
      peersValues: peerVals(nbvGrowthPct),
      higherBetter: true,
      n,
      displayValue: {
        current: fnum(y0.nbv),
        prev: fnum(y1.nbv),
        growth_pct: nbvGrowthPct(card),
      },
      extraReasons: ["寿险新业务价值同比增速；无 NBV 则该维缺失"],
    });
    dims.nbv_margin = applyNumeric({
      id: "nbv_margin",
      weight: weights.nbv_margin,
      value: fnum(y0.nbv_rate),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).nbv_rate)),
      higherBetter: true,
      n,
      displayValue: { nbv_rate: y0.nbv_rate, nbv: y0.nbv },
      extraReasons: ["NBV 率（东财 NBV_RATE）；营运利润/EV 无字段时的质量替代"],
    });
    dims.net_roi = applyNumeric({
      id: "net_roi",
      weight: weights.net_roi,
      value: fnum(y0.net_roi),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).net_roi)),
      higherBetter: true,
      n,
      displayValue: { net_roi: y0.net_roi },
      extraReasons: ["净投资收益率（固收底限）"],
    });
    dims.total_roi = applyNumeric({
      id: "total_roi",
      weight: weights.total_roi,
      value: fnum(y0.total_roi),
      peersValues: peerVals((c) => fnum(specialYear(c, 0).total_roi)),
      higherBetter: true,
      n,
      displayValue: { total_roi: y0.total_roi, source: y0.total_roi_source || null },
      extraReasons: [
        y0.total_roi_source === "interim"
          ? "总投资收益率（年报空，用同年度中报/三季回退）"
          : "总投资收益率（含权益弹性）",
      ],
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
    const y0 = specialYear(card, 0);
    dims.risk_coverage = applyNumeric({
      id: "risk_coverage",
      weight: weights.risk_coverage,
      value: fnum(y0.risk_coverage),
      peersValues: peerVals((c) => specialMetric(c, "risk_coverage")),
      higherBetter: true,
      n,
      extraReasons: ["风险覆盖率（监管核心，越高越好）"],
    });
    dims.capital_leverage = applyNumeric({
      id: "capital_leverage",
      weight: weights.capital_leverage,
      value: fnum(y0.capital_leverage),
      peersValues: peerVals((c) => specialMetric(c, "capital_leverage")),
      higherBetter: true,
      n,
      extraReasons: ["资本杠杆率（监管底线相关，越高越好）"],
    });
    dims.pledge_cover = applyNumeric({
      id: "pledge_cover",
      weight: weights.pledge_cover,
      value: fnum(y0.pledge_cover),
      peersValues: peerVals((c) => specialMetric(c, "pledge_cover")),
      higherBetter: true,
      n,
      displayValue: { pledge_cover: y0.pledge_cover, zqzy: y0.pledge_risk },
      extraReasons: ["质押履约保障比例 ZYGDSYLZQJZB（越高越稳；非质押/净资产敞口）"],
    });
    dims.margin_growth = applyNumeric({
      id: "margin_growth",
      weight: weights.margin_growth,
      value: fnum(y0.interest_yoy),
      peersValues: peerVals((c) => specialMetric(c, "interest_yoy")),
      higherBetter: true,
      n,
      displayValue: { interest_ratio: y0.interest_ratio, interest_yoy: y0.interest_yoy },
      extraReasons: ["利息收入同比（两融生息代理；无两融市占）"],
    });
    dims.prop_growth = applyNumeric({
      id: "prop_growth",
      weight: weights.prop_growth,
      value: fnum(y0.invest_yoy),
      peersValues: peerVals((c) => specialMetric(c, "invest_yoy")),
      higherBetter: true,
      n,
      displayValue: { invest_ratio: y0.invest_ratio, invest_yoy: y0.invest_yoy },
      extraReasons: ["投资收益同比（自营弹性代理；无自营投资收益率）"],
    });
    dims.fee_share = applyNumeric({
      id: "fee_share",
      weight: weights.fee_share,
      value: fnum(y0.fee_ratio),
      peersValues: peerVals((c) => specialMetric(c, "fee_ratio")),
      higherBetter: true,
      n,
      displayValue: { fee_ratio: y0.fee_ratio },
      extraReasons: ["手续费及佣金/营收（经纪+投行+资管基本盘）"],
    });
    dims.fee_growth = applyNumeric({
      id: "fee_growth",
      weight: weights.fee_growth,
      value: fnum(y0.fee_yoy),
      peersValues: peerVals((c) => specialMetric(c, "fee_yoy")),
      higherBetter: true,
      n,
      displayValue: { fee_yoy: y0.fee_yoy },
      extraReasons: ["手续费同比（投行/资管趋势代理，无法拆分）"],
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
      version: "peer-pool",
      f100: normF100(card.f100) || null,
      sources: {},
      pb_source: "仅池内同类分位",
    },
    dims,
    missing: result.missing,
    numeric_ok: result.missing.length === 0,
    total: result.total,
    rank: null,
    rank_n: n,
    rating: result.rating,
  };
}

/** 同一 f100 内按加权总分排名（并列共享名次，下一名跳过）。写入 score.rank / rank_n / rating。 */
export function assignPeerRanks(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const groups = new Map();
  for (const c of list) {
    const key = peerGroup(c, list).key || "f100:";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const rows of groups.values()) {
    const n = rows.length;
    const scored = rows
      .filter((c) => c.score && c.score.total != null)
      .sort((a, b) => (b.score.total ?? -1) - (a.score.total ?? -1) || String(a.code).localeCompare(String(b.code)));
    let i = 0;
    while (i < scored.length) {
      const t = scored[i].score.total;
      let j = i + 1;
      while (j < scored.length && scored[j].score.total === t) j += 1;
      const rank = i + 1;
      for (let k = i; k < j; k++) {
        scored[k].score.rank = rank;
        scored[k].score.rank_n = n;
        scored[k].score.rating = `第${rank}/${n}`;
      }
      i = j;
    }
    for (const c of rows) {
      if (!c.score) continue;
      c.score.rank_n = n;
      if (c.score.total == null) {
        c.score.rank = null;
        c.score.rating = "⚠️";
      }
    }
  }
  return list;
}

export function scoreAllCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const out = list.map((c) => ({ ...c, score: scoreCard(c, list) }));
  return assignPeerRanks(out);
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

  eq(roeBand("水力发电", 14), null, "roe-band-no-anchor", fails);
  eq(fcfBand(1.2, 1.2).max, 80, "fcf-good-cap80", fails);
  eq(fcfBand(1.8, 0.6).max, 50, "fcf-min-cover-cap", fails);
  eq(payBand("水力发电", 120, true).zone, "red>100", "pay-red", fails);
  eq(payBand("水力发电", 85, true).zone, "peer-pct", "pay-peer-pct", fails);

  const hot = overheatCap(22, [6, 7, 8, 5, 9, 7, 6]);
  eq(hot.cap, 50, "overheat-2x", fails);
  const elevated = overheatCap(12, [8, 8.5, 9, 7.5, 8, 9]);
  eq(elevated.cap, 80, "overheat-1.3-and-own-high", fails);
  const stable = overheatCap(13, [12, 13, 14, 12, 13, 14]);
  eq(stable.cap, null, "overheat-stable", fails);
  const tightHigh = overheatCap(13.5, [14, 13, 13.5, 12.8, 12.2, 12]);
  eq(tightHigh.cap, null, "overheat-tight-band", fails);

  const peerFin = finishScore({ pct: 100, n: 6, mode: "peer" });
  eq(peerFin.score, 100, "peer-finish", fails);
  const selfFin = finishScore({ pct: 75, n: 5, mode: "self" });
  eq(selfFin.score, 75, "self-finish", fails);
  eq(selfHistSeries(14, [14, 12, 11, 10]).length, 4, "self-series-has-current", fails);
  eq(selfHistSeries(14, [12, 11, 10]).length, 4, "self-series-prepend", fails);

  const passthrough = finishScore({ pct: 87.3, n: 6 });
  eq(passthrough.score, 87, "pct-passthrough", fails);

  const d100 = finishScore({ pct: 100, n: 6 });
  eq(d100.score, 100, "top-peer-pct", fails);

  // n=1 且无足够自身历史 → 缺维 ⚠️
  const soloMissing = scoreCard(
    {
      code: "solo",
      f100: "独苗业",
      roe3: 12,
      pay_ratio: 40,
      pb: 1.2,
      debt: 40,
      fcf_cov: [{ cover: 1.2 }],
      pay_hist: [],
      roe_hist: [],
    },
    [{ code: "solo", f100: "独苗业" }],
  );
  if (soloMissing.numeric_ok || soloMissing.rating !== "⚠️") {
    fails.push(`n1-no-hist-should-warn ${soloMissing.rating} missing=${JSON.stringify(soloMissing.missing)}`);
  }

  // n=1 有 ≥3 年自身史的维可打分；PB/负债/纪律等无年史仍缺维
  const soloHistCard = {
    code: "solo2",
    f100: "独苗业2",
    roe3: 14,
    pay_ratio: 60,
    pb: 1.5,
    debt: 45,
    fcf_cov: [
      { cover: 1.5, ocf: 15, profit: 10 },
      { cover: 1.2, ocf: 12, profit: 10 },
      { cover: 1.1, ocf: 11, profit: 10 },
    ],
    pay_hist: [60, 55, 50, 48, 45].map((pay_pct, i) => ({
      year: String(2025 - i),
      pay_pct,
      dps: 1 - i * 0.05,
    })),
    roe_hist: [14, 13, 12, 11, 10].map((roe, i) => ({ year: String(2025 - i), roe })),
    durability_evidence: {
      roic_5y: {
        history: [12, 11, 10, 9, 8].map((value, i) => ({ year: String(2025 - i), value })),
        n: 5,
        median: 10,
        stdev: 1.4,
      },
      gross_margin_5y: {
        history: [40, 39, 41, 38, 40].map((value, i) => ({ year: String(2025 - i), value })),
        n: 5,
        median: 40,
        stdev: 1.1,
      },
    },
  };
  const soloHist = scoreCard(soloHistCard, [soloHistCard]);
  if (soloHist.dims.roe?.score_mode !== "self_hist") fails.push(`n1-roe-mode ${soloHist.dims.roe?.score_mode}`);
  if (soloHist.dims.ocf_quality?.score == null) fails.push("n1-ocf-self-hist");
  if (soloHist.dims.pb?.usable) fails.push("n1-pb-should-missing");

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
    { code: "1", f100: "水力发电", roe3: 14, pay_ratio: 70, div: 4.5, pb: 2.0, debt: 50, fcf_cov: [{ cover: 1.6, ocf: 16, profit: 10 }] },
    { code: "2", f100: "水力发电", roe3: 11, pay_ratio: 65, div: 4.2, pb: 2.2, debt: 55, fcf_cov: [{ cover: 1.3, ocf: 13, profit: 10 }] },
    { code: "3", f100: "水力发电", roe3: 9, pay_ratio: 60, div: 3.9, pb: 2.4, debt: 58, fcf_cov: [{ cover: 1.1, ocf: 11, profit: 10 }] },
    { code: "4", f100: "水力发电", roe3: 8, pay_ratio: 55, div: 3.6, pb: 1.8, debt: 48, fcf_cov: [{ cover: 1.2, ocf: 12, profit: 10 }] },
    { code: "5", f100: "水力发电", roe3: 7.5, pay_ratio: 52, div: 3.3, pb: 1.6, debt: 45, fcf_cov: [{ cover: 1.0, ocf: 10, profit: 10 }] },
  ].map((card, idx) => ({
    ...card,
    durability_evidence: durable,
    pay_hist: disciplined.map((row, i) => ({
      ...row,
      dps: (row.dps || 1) * (1 + (4 - idx) * 0.02) * (1 - i * 0.02),
    })),
    roe_hist: [0, 1, 2, 3, 4].map((i) => ({ year: String(2025 - i), roe: card.roe3 - i * 0.1 })),
    special: {
      kind: "utility",
      years: [
        {
          interest_cover: 8 + (4 - idx),
          ar_days: 30 + idx * 5,
          rev_yoy: 6 - idx,
          profit_yoy: 8 - idx,
        },
        {
          interest_cover: 7 + (4 - idx),
          ar_days: 32 + idx * 5,
          rev_yoy: 4 - idx,
          profit_yoy: 5 - idx,
        },
      ],
    },
  }));
  const g = peerGroup(cards[0], cards);
  eq(g.escalated, false, "hydro-no-escalate", fails);
  eq(g.n, 5, "hydro-f100-n", fails);
  const s = scoreCard(cards[0], cards);
  if (s.kind !== "utility") fails.push(`hydro-kind ${s.kind}`);
  if (!s.numeric_ok) fails.push(`hydro-numeric-ok ${JSON.stringify(s.missing)}`);
  if (s.dims.pay || s.dims.fcf || s.dims.debt || s.dims.roe) fails.push("utility-must-drop-pay-fcf-debt-roe");
  if (!s.dims.ocf_quality?.usable) fails.push("utility-ocf-missing");
  if (!s.dims.interest_cover?.usable) fails.push("utility-interest-missing");
  if (!s.dims.dps_growth?.usable) fails.push("utility-dps-growth-missing");
  if (s.total == null || s.rating === "⚠️") fails.push("fully-numeric-total");
  if (s.dims.roic_durability.score == null || s.dims.margin_durability.score == null) {
    fails.push("corp-durability-missing");
  }
  const utilMissingW = Object.keys(WEIGHTS.utility).filter((id) => !s.dims[id]?.usable);
  if (utilMissingW.length) fails.push(`utility-weight-dims ${utilMissingW.join(",")}`);
  const rankedHydro = scoreAllCards(cards);
  eq(rankedHydro[0].score.rank, 1, "hydro-rank1", fails);
  eq(rankedHydro[0].score.rating, "第1/5", "hydro-rank-label", fails);
  eq(rankedHydro[0].score.rank_n, 5, "hydro-rank-n", fails);

  const appliancePeer = [
    {
      code: "c1",
      f100: "白色家电",
      roe3: 14,
      pay_ratio: 40,
      div: 4.5,
      pb: 2.0,
      pe: 10,
      debt: 40,
      fcf_cov: [
        { cover: 1.6, ocf: 20, profit: 10 },
        { cover: 1.5, ocf: 18, profit: 10 },
        { cover: 1.4, ocf: 16, profit: 10 },
      ],
      durability_evidence: durable,
      pay_hist: disciplined,
      special: {
        kind: "appliance",
        years: [
          { contract_liab_yoy: 20, ar_days: 20, inv_days: 50 },
          { contract_liab_yoy: 15, ar_days: 22, inv_days: 52 },
          { contract_liab_yoy: 10, ar_days: 24, inv_days: 55 },
        ],
      },
    },
    {
      code: "c2",
      f100: "白色家电",
      roe3: 12,
      pay_ratio: 38,
      div: 4.0,
      pb: 2.2,
      pe: 12,
      debt: 42,
      fcf_cov: [
        { cover: 1.0, ocf: 10, profit: 10 },
        { cover: 0.9, ocf: 9, profit: 10 },
        { cover: 0.8, ocf: 8, profit: 10 },
      ],
      durability_evidence: durable,
      pay_hist: disciplined,
      special: {
        kind: "appliance",
        years: [
          { contract_liab_yoy: 0, ar_days: 40, inv_days: 90 },
          { contract_liab_yoy: -5, ar_days: 42, inv_days: 95 },
          { contract_liab_yoy: -8, ar_days: 45, inv_days: 100 },
        ],
      },
    },
  ];
  const strongApp = scoreCard(appliancePeer[0], appliancePeer);
  const weakApp = scoreCard(appliancePeer[1], appliancePeer);
  if (strongApp.kind !== "appliance") fails.push(`appliance-peer-kind ${strongApp.kind}`);
  if ((strongApp.total || 0) <= (weakApp.total || 0)) {
    fails.push(`appliance-peer-order strong=${strongApp.total} weak=${weakApp.total}`);
  }
  if (!strongApp.dims.ocf_quality?.usable) fails.push("appliance-ocf-missing");

  const bankBase = {
    f100: "银行Ⅱ",
    fin_kind: "bank",
    roe3: 10,
    pay_ratio: 32,
    div: 5.0,
    pb: 0.65,
    pay_hist: disciplined,
    roe_hist: [10, 10.2, 9.8, 10.1, 9.9].map((roe, i) => ({ year: String(2025 - i), roe })),
    special: {
      kind: "bank",
      years: [
        {
          npl: 1.0,
          provision: 220,
          cet1: 12,
          nim: 1.8,
          npl_amt: 100,
          gross_loans: 10000,
          overdue_loans: 110,
          nonint_ratio: 28,
        },
        {
          npl: 1.05,
          provision: 210,
          cet1: 11.8,
          nim: 1.78,
          npl_amt: 95,
          gross_loans: 9500,
          overdue_loans: 108,
          nonint_ratio: 27,
        },
      ],
    },
  };
  const banks = [1, 2, 3, 4].map((i) => ({
    ...bankBase,
    code: `b${i}`,
    pb: 0.6 + i * 0.03,
    div: 4.5 + i * 0.15,
  }));
  const bankScore = scoreCard(banks[0], banks);
  if (!bankScore.numeric_ok || bankScore.total == null) fails.push(`bank-full-score ${JSON.stringify(bankScore.missing)}`);
  const bankMissingW = Object.keys(WEIGHTS.bank).filter((id) => !bankScore.dims[id]?.usable);
  if (bankMissingW.length) fails.push(`bank-weight-dims ${bankMissingW.join(",")}`);
  if (!bankScore.dims.div_yield?.usable) fails.push("bank-div-yield-missing");
  if (bankScore.dims.nim_trend.score !== 50) fails.push(`bank-nim-tied ${bankScore.dims.nim_trend.score}`);
  if (bankScore.dims.pb.score < 50) fails.push(`bank-pb-class-band ${bankScore.dims.pb.score}`);
  const bankW = Object.values(WEIGHTS.bank).reduce((s, w) => s + w, 0);
  if (Math.abs(bankW - 1) > 1e-9) fails.push(`bank-weights-sum ${bankW}`);
  eq(nimTrendCap(-0.11, [-0.14, -0.13, -0.12, -0.1]).cap, null, "nim-inline-no-cap", fails);
  eq(nimTrendCap(-0.21, [-0.1, -0.11, -0.12, -0.09]).cap, 20, "nim-idio-hard", fails);
  eq(nimTrendCap(-0.12, [-0.04, -0.03, -0.05, -0.02]).cap, 80, "nim-idio-mild", fails);

  const insuranceBase = {
    f100: "保险Ⅱ",
    fin_kind: "insurance",
    roe3: 11,
    pay_ratio: 30,
    div: 4.2,
    pb: 0.75,
    pay_hist: disciplined,
    roe_hist: [11, 10.8, 11.2, 10.7, 11.1].map((roe, i) => ({ year: String(2025 - i), roe })),
    special: {
      kind: "insurance",
      years: [
        { solvency: 220, net_roi: 4.5, total_roi: 5.2, nbv: 20e9, nbv_rate: 18 },
        { solvency: 215, net_roi: 4.4, total_roi: 4.8, nbv: 18e9, nbv_rate: 16 },
      ],
    },
  };
  const insurers = [1, 2, 3, 4].map((i) => ({
    ...insuranceBase,
    code: `i${i}`,
    pb: 0.7 + i * 0.03,
    div: 3.8 + i * 0.15,
    special: {
      kind: "insurance",
      years: [
        {
          solvency: 210 + i * 5,
          net_roi: 4.0 + i * 0.1,
          total_roi: 4.8 + i * 0.15,
          nbv: (16 + i) * 1e9,
          nbv_rate: 14 + i,
        },
        {
          solvency: 205 + i * 5,
          net_roi: 3.9 + i * 0.1,
          total_roi: 4.5 + i * 0.1,
          nbv: (14 + i) * 1e9,
          nbv_rate: 13 + i,
        },
      ],
    },
  }));
  const insW = Object.values(WEIGHTS.insurance).reduce((s, w) => s + w, 0);
  if (Math.abs(insW - 1) > 1e-9) fails.push(`insurance-weights-sum ${insW}`);
  const insuranceScore = scoreCard(insurers[0], insurers);
  if (!insuranceScore.numeric_ok || insuranceScore.total == null) {
    fails.push(`insurance-full-score ${JSON.stringify(insuranceScore.missing)}`);
  }
  const insMissingW = Object.keys(WEIGHTS.insurance).filter((id) => !insuranceScore.dims[id]?.usable);
  if (insMissingW.length) fails.push(`insurance-weight-dims ${insMissingW.join(",")}`);
  if (!insuranceScore.dims.div_yield?.usable) fails.push("insurance-div-yield-missing");
  if (insuranceScore.dims.pay) fails.push("insurance-must-not-use-pay");
  if (insuranceScore.dims.roi_trend) fails.push("insurance-must-not-use-roi-trend");
  if (!insuranceScore.dims.nbv_growth?.usable) fails.push("insurance-nbv-growth-missing");
  const brokerBase = {
    f100: "证券",
    roe3: 8.5,
    pay_ratio: 32,
    div: 3.5,
    pb: 1.05,
    debt: 78,
    pay_hist: disciplined,
    roe_hist: [8.5, 8.2, 8.0, 8.3, 8.1].map((roe, i) => ({ year: String(2025 - i), roe })),
    special: {
      kind: "broker",
      years: [
        {
          risk_coverage: 280,
          capital_leverage: 18,
          pledge_cover: 320,
          fee_ratio: 42,
          fee_yoy: 20,
          interest_yoy: 10,
          invest_yoy: 30,
        },
        {
          risk_coverage: 260,
          capital_leverage: 17,
          pledge_cover: 310,
          fee_ratio: 40,
          fee_yoy: 5,
          interest_yoy: 2,
          invest_yoy: 15,
        },
      ],
    },
  };
  const brokers = [1, 2, 3, 4].map((i) => ({
    ...brokerBase,
    code: `s${i}`,
    pb: 0.95 + i * 0.04,
    debt: 76 + i,
    div: 3.2 + i * 0.1,
    special: {
      kind: "broker",
      years: [
        {
          risk_coverage: 250 + i * 20,
          capital_leverage: 15 + i,
          pledge_cover: 300 + i * 10,
          fee_ratio: 38 + i,
          fee_yoy: 10 + i * 5,
          interest_yoy: 5 + i * 3,
          invest_yoy: 15 + i * 8,
        },
        {
          risk_coverage: 240 + i * 15,
          capital_leverage: 14 + i,
          pledge_cover: 290 + i * 8,
          fee_ratio: 37 + i,
          fee_yoy: 2 + i,
          interest_yoy: 1 + i,
          invest_yoy: 8 + i * 2,
        },
      ],
    },
  }));
  const brokerScore = scoreCard(brokers[0], brokers);
  if (brokerScore.kind !== "broker") fails.push(`broker-kind ${brokerScore.kind}`);
  if (brokerScore.dims.fcf) fails.push("broker-must-not-use-fcf");
  if (brokerScore.dims.debt) fails.push("broker-must-not-use-debt");
  if (brokerScore.dims.pay) fails.push("broker-must-not-use-pay");
  if (!brokerScore.numeric_ok || brokerScore.total == null) {
    fails.push(`broker-full-score ${JSON.stringify(brokerScore.missing)}`);
  }
  const broMissingW = Object.keys(WEIGHTS.broker).filter((id) => !brokerScore.dims[id]?.usable);
  if (broMissingW.length) fails.push(`broker-weight-dims ${broMissingW.join(",")}`);
  if (!brokerScore.dims.div_yield?.usable) fails.push("broker-div-yield-missing");
  if (!brokerScore.dims.risk_coverage?.usable) fails.push("broker-risk-coverage-missing");
  const sniffBank = scoreCard({ ...brokerBase, code: "sniff", special: { kind: "bank", years: [{ npl: 1 }] } }, brokers);
  if (sniffBank.kind !== "broker") fails.push(`broker-f100-beats-npl ${sniffBank.kind}`);

  for (const k of [
    "corp",
    "utility",
    "brand_consumer",
    "resource_cycle",
    "infra_construction",
    "appliance",
    "equip_mfg",
    "tech_hardware",
    "bank",
    "insurance",
    "broker",
  ]) {
    const sum = Object.values(WEIGHTS[k]).reduce((s, w) => s + w, 0);
    if (Math.abs(sum - 1) > 1e-9) fails.push(`weights-sum-${k} ${sum}`);
  }
  if (WEIGHTS.telecom) fails.push("telecom-template-should-be-removed");
  if (finKindFromF100("水力发电") !== "utility") fails.push("hydro-utility-kind");
  if (finKindFromF100("通信服务") !== "utility") fails.push("telecom-utility-kind");
  if (finKindFromF100("白酒Ⅱ") !== "brand_consumer") fails.push("liquor-brand-kind");
  if (finKindFromF100("白色家电") !== "appliance") fails.push("appliance-kind");
  if (finKindFromF100("轨交设备") !== "equip_mfg") fails.push("equip-kind");
  if (finKindFromF100("计算机设备") !== "tech_hardware") fails.push("tech-kind");
  if (finKindFromF100("水泥") !== "resource_cycle") fails.push("cement-resource-kind");
  if (finKindFromF100("食品加工") !== "brand_consumer") fails.push("food-brand-kind");

  const moutaiPb = pbBand("白酒Ⅱ", 6.68);
  if (!moutaiPb || moutaiPb.source !== "class") {
    fails.push(`baijiu-pb-class ${JSON.stringify(moutaiPb)}`);
  }
  const noAnchorPb = pbBand("半导体", 6.68);
  if (!noAnchorPb || noAnchorPb.source !== "class" || noAnchorPb.max !== 0) {
    fails.push(`chip-pb-class-expensive ${JSON.stringify(noAnchorPb)}`);
  }

  const liquor = [
    { code: "600519", f100: "白酒Ⅱ", roe3: 34, pay_ratio: 79, div: 3.5, pb: 6.68, pe: 22, debt: 16, fcf_cov: [{ cover: 1.1, ocf: 60, profit: 50, capex: 5 }, { cover: 1.3, ocf: 55, profit: 48, capex: 5 }, { cover: 1.2, ocf: 50, profit: 45, capex: 4 }] },
    { code: "000858", f100: "白酒Ⅱ", roe3: 18, pay_ratio: 70, div: 4.8, pb: 2.43, pe: 14, debt: 36, fcf_cov: [{ cover: 1.4, ocf: 40, profit: 28, capex: 3 }, { cover: 1.4, ocf: 38, profit: 26, capex: 3 }, { cover: 1.3, ocf: 35, profit: 24, capex: 3 }] },
    { code: "000568", f100: "白酒Ⅱ", roe3: 29, pay_ratio: 78, div: 4.2, pb: 2.55, pe: 16, debt: 30, fcf_cov: [{ cover: 1.2, ocf: 30, profit: 22, capex: 2 }, { cover: 1.1, ocf: 28, profit: 20, capex: 2 }, { cover: 1.1, ocf: 26, profit: 18, capex: 2 }] },
    { code: "600809", f100: "白酒Ⅱ", roe3: 38, pay_ratio: 65, div: 3.0, pb: 4.07, pe: 20, debt: 25, fcf_cov: [{ cover: 1.0, ocf: 25, profit: 20, capex: 2 }, { cover: 1.2, ocf: 22, profit: 18, capex: 2 }, { cover: 1.1, ocf: 20, profit: 16, capex: 2 }] },
  ].map((card, idx) => ({
    ...card,
    durability_evidence: {
      ...durable,
      roic_5y: {
        ...durable.roic_5y,
        history: [24, 23, 22, 21, 20].map((value, i) => ({ year: String(2025 - i), value })),
        median: 22,
      },
      gross_margin_5y: {
        history: [90 - idx, 89 - idx, 88 - idx, 87 - idx, 86 - idx].map((value, i) => ({
          year: String(2025 - i),
          value,
        })),
        n: 5,
        median: 88 - idx,
        stdev: 1.2,
      },
    },
    pay_hist: disciplined,
    roe_hist: [0, 1, 2, 3, 4].map((i) => ({ year: String(2025 - i), roe: card.roe3 - i * 0.2 })),
    special: {
      kind: "brand_consumer",
      years: [
        { contract_liab_yoy: 10 - idx * 8, ar_days: 1 + idx },
        { contract_liab_yoy: 5 - idx * 5, ar_days: 2 + idx },
      ],
    },
  }));
  const ms = scoreCard(liquor[0], liquor);
  const wy = scoreCard(liquor[1], liquor);
  if (ms.kind !== "brand_consumer") fails.push(`liquor-score-kind ${ms.kind}`);
  if (ms.dims.fcf || ms.dims.pay || ms.dims.pb) fails.push("brand-must-drop-fcf-pay-pb");
  if (!ms.numeric_ok) fails.push(`liquor-numeric-ok ${JSON.stringify(ms.missing)}`);
  if (ms.dims.pe?.score == null || wy.dims.pe?.score == null) fails.push("liquor-pe-missing");
  if (wy.dims.pe.score <= ms.dims.pe.score) fails.push(`pe-peer-rank wy=${wy.dims.pe.score} ms=${ms.dims.pe.score}`);
  if (!ms.dims.contract_liab_trend?.usable) fails.push("liquor-contract-missing");
  const brandMissingW = Object.keys(WEIGHTS.brand_consumer).filter((id) => !ms.dims[id]?.usable);
  if (brandMissingW.length) fails.push(`brand-weight-dims ${brandMissingW.join(",")}`);
  const pg = peerGroup(liquor[0], liquor);
  if (pg.key !== "f100:白酒" || pg.n !== 4) fails.push(`baijiu-peer ${pg.key} n=${pg.n}`);
  const liquorRanked = scoreAllCards(liquor);
  const moutai = liquorRanked.find((c) => c.code === "600519");
  if (!moutai?.score?.rank || moutai.score.rank_n !== 4) {
    fails.push(`liquor-rank ${moutai?.score?.rating}`);
  }

  const builders = [
    {
      code: "601668",
      f100: "房屋建设Ⅱ",
      div: 4.2,
      pb: 0.55,
      pe: 5.5,
      debt: 75,
      fcf_cov: [
        { cover: 0.8, ocf: 80e9, profit: 50e9, capex: 20e9 },
        { cover: 0.9, ocf: 70e9, profit: 45e9, capex: 18e9 },
      ],
      durability_evidence: {
        roic_5y: {
          history: [4.5, 4.2, 4.0, 3.8, 3.5].map((value, i) => ({ year: String(2025 - i), value })),
          n: 5,
          median: 4.0,
          stdev: 0.35,
        },
        gross_margin_5y: {
          history: [10.2, 9.9, 9.7, 9.5, 9.3].map((value, i) => ({ year: String(2025 - i), value })),
          n: 5,
          median: 9.7,
          stdev: 0.3,
        },
      },
      pay_hist: disciplined,
      special: {
        kind: "infra_construction",
        years: [
          {
            interest_cover: 2.5,
            interest_debt: 25,
            ar_days: 60,
            ar_yoy: 8,
            contract_asset: 600e9,
            contract_asset_yoy: 12,
            operate_reve: 2000e9,
          },
          { interest_cover: 2.2, interest_debt: 26, ar_days: 62, ar_yoy: 10, contract_asset_yoy: 8 },
        ],
      },
    },
    {
      code: "601186",
      f100: "房屋建设Ⅱ",
      div: 3.5,
      pb: 0.48,
      pe: 6.2,
      debt: 78,
      fcf_cov: [
        { cover: 0.5, ocf: 30e9, profit: 40e9, capex: 15e9 },
        { cover: 0.4, ocf: 25e9, profit: 35e9, capex: 12e9 },
      ],
      durability_evidence: {
        roic_5y: {
          history: [3.2, 3.0, 2.9, 2.8, 2.7].map((value, i) => ({ year: String(2025 - i), value })),
          n: 5,
          median: 2.9,
          stdev: 0.2,
        },
        gross_margin_5y: {
          history: [9.5, 9.8, 10.0, 10.2, 10.4].map((value, i) => ({ year: String(2025 - i), value })),
          n: 5,
          median: 10.0,
          stdev: 0.3,
        },
      },
      pay_hist: [
        { year: "2024", dps: 0.18 },
        { year: "2023", dps: 0.2 },
        { year: "2022", dps: 0.22 },
        { year: "2021", dps: 0.2 },
      ],
      special: {
        kind: "infra_construction",
        years: [
          {
            interest_cover: 0.5,
            interest_debt: 32,
            ar_days: 90,
            ar_yoy: 25,
            contract_asset: 400e9,
            contract_asset_yoy: -5,
            operate_reve: 1200e9,
          },
          { interest_cover: 0.4, interest_debt: 33, ar_days: 95, ar_yoy: 28, contract_asset_yoy: -2 },
        ],
      },
    },
  ];
  const infraA = scoreCard(builders[0], builders);
  const infraB = scoreCard(builders[1], builders);
  if (infraA.kind !== "infra_construction") fails.push(`infra-kind ${infraA.kind}`);
  if (infraA.dims.fcf || infraA.dims.pay || infraA.dims.roe || infraA.dims.debt) {
    fails.push("infra-must-drop-fcf-pay-roe-debt");
  }
  if (!infraA.numeric_ok) fails.push(`infra-numeric-ok ${JSON.stringify(infraA.missing)}`);
  const infraMissingW = Object.keys(WEIGHTS.infra_construction).filter((id) => !infraA.dims[id]?.usable);
  if (infraMissingW.length) fails.push(`infra-weight-dims ${infraMissingW.join(",")}`);
  if ((infraA.total || 0) <= (infraB.total || 0)) {
    fails.push(`infra-peer-order a=${infraA.total} b=${infraB.total}`);
  }

  const appliances = [0, 1, 2].map((idx) => ({
    code: ["000651", "600690", "000333"][idx],
    f100: "白色家电",
    div: 4.5 - idx * 0.3,
    pb: 1.2 + idx * 0.2,
    pe: 10 + idx,
    debt: 20 + idx,
    roe3: 20 - idx,
    fcf_cov: [
      { cover: 1.2, ocf: 30e9, profit: 20e9, capex: 3e9 },
      { cover: 1.1, ocf: 28e9, profit: 19e9, capex: 3e9 },
      { cover: 1.0, ocf: 26e9, profit: 18e9, capex: 2e9 },
    ],
    durability_evidence: {
      roic_5y: {
        history: [15 - idx, 14 - idx, 13 - idx, 12 - idx, 11 - idx].map((value, i) => ({
          year: String(2025 - i),
          value,
        })),
        n: 5,
        median: 13 - idx,
        stdev: 1,
      },
      gross_margin_5y: {
        history: [30 - idx, 29 - idx, 28 - idx, 27 - idx, 26 - idx].map((value, i) => ({
          year: String(2025 - i),
          value,
        })),
        n: 5,
        median: 28 - idx,
        stdev: 1.2,
      },
    },
    pay_hist: disciplined,
    roe_hist: [0, 1, 2, 3, 4].map((i) => ({ year: String(2025 - i), roe: 20 - idx - i * 0.2 })),
    special: {
      kind: "appliance",
      years: [
        { contract_liab_yoy: 10 - idx * 5, ar_days: 30 + idx * 10, inv_days: 70 + idx * 20 },
        { contract_liab_yoy: 5 - idx * 3, ar_days: 32 + idx * 10, inv_days: 72 + idx * 20 },
        { contract_liab_yoy: 2, ar_days: 35, inv_days: 75 },
      ],
    },
  }));
  const gree = scoreCard(appliances[0], appliances);
  if (gree.kind !== "appliance") fails.push(`appliance-kind-score ${gree.kind}`);
  if (gree.dims.fcf || gree.dims.pay) fails.push("appliance-must-drop-fcf-pay");
  const appMissing = Object.keys(WEIGHTS.appliance).filter((id) => !gree.dims[id]?.usable);
  if (appMissing.length) fails.push(`appliance-weight-dims ${appMissing.join(",")}`);
  if (!gree.numeric_ok) fails.push(`appliance-numeric-ok ${JSON.stringify(gree.missing)}`);

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
