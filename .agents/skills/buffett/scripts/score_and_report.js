#!/usr/bin/env node
/**
 * 对 Step1 pass 列表做简化六维评分 + 后复权布林 + 落盘报告（buffett 验收流）。
 *
 * 用法:
 *   node score_and_report.js \
 *     --step1 /tmp/buffett_step1.json \
 *     --f10 /tmp/buffett_f10.json \
 *     --bond /tmp/buffett_bond.json \
 *     --xuangu /tmp/buffett_xuangu_result.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, readJsonFile } from "./opencli_json.js";
import { fetchBrowser } from "./fetch_kline_hfq.js";

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function bollinger(closes, window = 20, nbdev = 2.0) {
  if (closes.length < window) return null;
  const w = closes.slice(-window);
  const mid = w.reduce((a, b) => a + b, 0) / window;
  const variance = w.reduce((a, x) => a + (x - mid) ** 2, 0) / window;
  const sd = Math.sqrt(variance);
  const up = mid + nbdev * sd;
  const lo = mid - nbdev * sd;
  const c = closes[closes.length - 1];
  const bw = mid ? (up - lo) / mid : null;
  return {
    close: round(c, 4),
    mid: round(mid, 4),
    upper: round(up, 4),
    lower: round(lo, 4),
    bandwidth_pct: bw == null ? null : round(bw * 100, 2),
  };
}

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function payoutBand(cls) {
  return (
    {
      A: [50, 80],
      B: [50, 70],
      C: [40, 70],
      D: [30, 60],
      E: [25, 40],
      F: [20, 40],
      G: [30, 70],
    }[cls] || [30, 70]
  );
}

function roeLine(cls) {
  return { A: 8, B: 9, C: 10, D: 12, E: 9, F: 10, G: 12 }[cls] ?? 12;
}

function debtLine(cls) {
  return { A: 65, B: 55, C: 55, D: 60, F: 75, G: 60 }[cls];
}

function entType(controller, holder, orgForm) {
  const ctrl = `${controller || ""}${holder || ""}${orgForm || ""}`;
  if (["国务院", "中央汇金", "财政部"].some((k) => ctrl.includes(k))) return "中央国企";
  if (
    controller &&
    ["省", "市", "自治区"].some((k) => controller.includes(k)) &&
    !controller.includes("国务院")
  ) {
    return "地方国企";
  }
  if (["国资委", "国有资产", "央企"].some((k) => ctrl.includes(k))) {
    return !String(controller || "").includes("省") && !String(controller || "").includes("市")
      ? "中央国企"
      : "地方国企";
  }
  if (controller) return "其他";
  return "未知";
}

/** 行业先验：只作「难复制优势」底分，不是护城河满分尺 */
function franchisePrior(cls) {
  return { A: 70, B: 70, C: 55, D: 35, E: 65, F: 50, G: 45 }[cls] ?? 45;
}

function roeTierScore(roe3, rl) {
  if (roe3 == null || rl == null) return null;
  if (roe3 >= rl * 1.3) return 100;
  if (roe3 >= rl) return 80;
  if (roe3 >= rl * 0.8) return 50;
  return 20;
}

function fcfTierScore(cover) {
  if (cover == null) return null;
  if (cover >= 1.2) return 100;
  if (cover >= 1.0) return 80;
  if (cover >= 0.7) return 50;
  return 20;
}

/**
 * 护城河 ≈ 难复制优势 × 回报兑现 × 分红纪律
 * 脚本：0.40×优势 + 0.35×兑现 + 0.25×纪律，再套封顶。
 * 市值仅辅助 +5/+10；禁止「仅大市值→100」。
 */
function scoreMoat({
  cls,
  roe3,
  rl,
  pay,
  payLo,
  payHi,
  covers,
  divStreak,
  finKind,
  years,
  mktYi,
}) {
  const basis = [];

  let adv = franchisePrior(cls);
  basis.push(`优势先验${adv}(行业${cls})`);
  if (mktYi != null && mktYi >= 5000) {
    adv = Math.min(100, adv + 10);
    basis.push("市值≥5000辅助+10");
  } else if (mktYi != null && mktYi >= 2000) {
    adv = Math.min(100, adv + 5);
    basis.push("市值≥2000辅助+5");
  }

  let ret = null;
  if (finKind === "bank") {
    const aq = scoreAssetQualityBank(years);
    const cet = scoreCet1(years);
    const parts = [aq.score, cet.score].filter((x) => x != null);
    if (!parts.length) {
      return { score: null, value: null, gap: "护城河-回报兑现缺失(银行专项)" };
    }
    ret = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
    basis.push(`兑现(资产质量/核充)→${ret}`);
  } else if (finKind === "insurance") {
    const sol = scoreSolvency(years);
    if (sol.score == null) {
      return { score: null, value: null, gap: "护城河-回报兑现缺失(偿付)" };
    }
    ret = sol.score;
    basis.push(`兑现(偿付)→${ret}`);
  } else {
    const roePart = roeTierScore(roe3, rl);
    const fcfPart = covers?.length ? fcfTierScore(covers[0]) : null;
    if (roePart == null && fcfPart == null) {
      return { score: null, value: null, gap: "护城河-回报兑现缺失(ROE/FCF)" };
    }
    if (roePart == null) ret = fcfPart;
    else if (fcfPart == null) ret = roePart;
    else ret = Math.round(0.5 * roePart + 0.5 * fcfPart);
    basis.push(`兑现(ROE/FCF)→${ret}`);
  }

  let divDisc = null;
  if (pay == null) {
    return { score: null, value: null, gap: "护城河-分红纪律缺失(派息率)" };
  }
  if (pay > 100) divDisc = 0;
  else if (pay >= payLo && pay <= payHi) divDisc = 100;
  else if (Math.abs(pay - (payLo + payHi) / 2) <= 10) divDisc = 70;
  else divDisc = 40;
  if (divStreak != null && divStreak >= 10) {
    divDisc = Math.min(100, divDisc + 10);
    basis.push(`连续分红${divStreak}y+10`);
  } else if (divStreak != null) {
    basis.push(`连续分红${divStreak}y`);
  }
  basis.push(`分红纪律→${divDisc}`);

  let score = Math.round(0.4 * adv + 0.35 * ret + 0.25 * divDisc);
  if (ret < 50) score = Math.min(score, 50);
  if (!(ret >= 80 && divDisc >= 80)) score = Math.min(score, 85);
  if (cls === "D") score = Math.min(score, 50);
  basis.push(`合成${score}`);
  return { score, value: basis.join("; "), gap: null };
}

function scoreAssetQualityBank(years) {
  const y0 = years[0] || {};
  const y1 = years[1] || {};
  const y2 = years[2] || {};
  const npl = fnum(y0.npl);
  const prov = fnum(y0.provision);
  if (npl == null || prov == null) return { score: null, value: null };
  const npl1 = fnum(y1.npl);
  const npl2 = fnum(y2.npl);
  const rising2 = npl1 != null && npl2 != null && npl > npl1 && npl1 > npl2;
  if (rising2 && prov < 150) {
    return { score: 0, value: `不良${npl}%/拨备${prov}%/连升2年`, red: true };
  }
  if (npl <= 1.2 && prov >= 250) return { score: 100, value: `不良${npl}%/拨备${prov}%` };
  if (npl <= 1.5 && prov >= 150) return { score: 80, value: `不良${npl}%/拨备${prov}%` };
  if (npl <= 2.0 && prov >= 120) return { score: 50, value: `不良${npl}%/拨备${prov}%` };
  return { score: 20, value: `不良${npl}%/拨备${prov}%` };
}

function scoreCet1(years) {
  const cet1 = fnum(years[0]?.cet1);
  if (cet1 == null) return { score: null, value: null };
  if (cet1 >= 12) return { score: 100, value: `${cet1}%` };
  if (cet1 >= 9.5) return { score: 80, value: `${cet1}%` };
  if (cet1 >= 8.5) return { score: 50, value: `${cet1}%` };
  return { score: 20, value: `${cet1}%` };
}

/** bp 趋势：当前 − 上年，负=收窄 */
function scoreTrendBp(curr, prev) {
  if (curr == null || prev == null) return { score: null, value: null };
  const bp = Math.round((curr - prev) * 100);
  const value = `${curr}%→年变${bp}bp`;
  if (bp >= -10) return { score: 100, value };
  if (bp >= -20) return { score: 60, value };
  return { score: 30, value };
}

function scoreSolvency(years) {
  const s0 = fnum(years[0]?.solvency);
  const s1 = fnum(years[1]?.solvency);
  if (s0 == null) return { score: null, value: null };
  const falling2 =
    s1 != null &&
    years[2] &&
    fnum(years[2].solvency) != null &&
    s0 < s1 &&
    s1 < fnum(years[2].solvency);
  if (falling2 && s0 < 150) return { score: 0, value: `${s0}%连降`, red: true };
  if (s0 >= 200) return { score: 100, value: `${s0}%` };
  if (s0 >= 150) return { score: 80, value: `${s0}%` };
  if (s0 >= 120) return { score: 50, value: `${s0}%` };
  return { score: 20, value: `${s0}%` };
}

function packDim(dim, score, w, value) {
  return {
    dim,
    score,
    w,
    contrib: score == null ? null : round(score * w, 1),
    value: value ?? null,
  };
}

function scoreOne(row, f10, bands) {
  const cls = row.ind_class || "G";
  const finKind = f10.special?.kind || (cls === "E" ? null : "corp");
  const isBankLike = cls === "E";
  const pay = fnum(f10.pay_ratio);
  const roe3 = fnum(f10.roe3);
  const debt = fnum(f10.debt);
  const pb = fnum(f10.quote?.priceBook) ?? fnum(row.pb);
  const price = fnum(f10.quote?.price) ?? fnum(row.price);
  const mktYi = fnum(row.mkt_yi) ?? (fnum(f10.quote?.marketCap) != null
    ? fnum(f10.quote.marketCap) / 1e8
    : null);
  const [lo, hi] = payoutBand(cls);
  const rl = roeLine(cls);
  const years = f10.special?.years || [];
  const gaps = [];
  const red = [];
  const covers = (f10.fcf_cov || []).map((x) => x.cover).filter((x) => x != null);

  let payScore;
  let payValue = pay;
  if (pay == null) {
    payScore = null;
    gaps.push("派息率缺失");
  } else if (pay >= lo && pay <= hi) payScore = 100;
  else if (Math.abs(pay - (lo + hi) / 2) <= 10) payScore = 70;
  else if (pay > 100) payScore = 0;
  else payScore = 40;

  let roeScore;
  if (roe3 == null) {
    roeScore = null;
    gaps.push("ROE3缺失");
  } else if (roe3 >= rl * 1.3) roeScore = 100;
  else if (roe3 >= rl) roeScore = 80;
  else if (roe3 >= rl * 0.8) roeScore = 50;
  else roeScore = 20;

  const pbCap = { A: 2.5, B: 1.5, C: 1.5, D: 1.0, E: 0.8, F: 0.8, G: 1.2 }[cls] ?? 1.2;
  let pbScore;
  if (pb == null) {
    pbScore = null;
    gaps.push("PB缺失");
  } else if (pb <= pbCap * 0.7) pbScore = 100;
  else if (pb <= pbCap) pbScore = 80;
  else if (pb <= pbCap * 1.2) pbScore = 50;
  else pbScore = 20;

  const moatFinKind =
    finKind === "bank" || finKind === "insurance" ? finKind : "corp";
  const moat = scoreMoat({
    cls,
    roe3,
    rl,
    pay,
    payLo: lo,
    payHi: hi,
    covers,
    divStreak: fnum(row.div_streak),
    finKind: moatFinKind,
    years,
    mktYi,
  });
  if (moat.score == null && moat.gap) gaps.push(moat.gap);

  let weights;
  let condCover = false;

  if (isBankLike && finKind === "bank") {
    const aq = scoreAssetQualityBank(years);
    const cet = scoreCet1(years);
    const nim = scoreTrendBp(fnum(years[0]?.nim), fnum(years[1]?.nim));
    if (aq.score == null) gaps.push("不良率/拨备覆盖率缺失");
    if (cet.score == null) gaps.push("核心一级资本充足率(HXYJBCZL)缺失");
    if (nim.score == null) gaps.push("净息差趋势缺失（需近2年NET_INTEREST_MARGIN）");
    if (aq.red) red.push("不良连升且拨备<150%");
    const aqOk = aq.score != null && aq.score >= 80;
    const cetOk = fnum(years[0]?.cet1) != null && fnum(years[0].cet1) >= 9.5;
    condCover = aqOk && cetOk;
    weights = [
      packDim("资产质量", aq.score, 0.25, aq.value),
      packDim("护城河", moat.score, 0.25, moat.value),
      packDim("核充率", cet.score, 0.15, cet.value),
      packDim("派息率", payScore, 0.15, payValue),
      packDim("ROE", roeScore, 0.1, roe3),
      packDim("净息差", nim.score, 0.1, nim.value),
    ];
  } else if (isBankLike && finKind === "insurance") {
    const sol = scoreSolvency(years);
    const roi = scoreTrendBp(fnum(years[0]?.net_roi), fnum(years[1]?.net_roi));
    if (sol.score == null) gaps.push("综合偿付能力充足率(SOLVENCY_AR)缺失");
    if (roi.score == null) gaps.push("投资收益率趋势缺失（需近2年NET_ROI）");
    if (sol.red) red.push("偿付能力连降且<150%");
    const solOk = fnum(years[0]?.solvency) != null && fnum(years[0].solvency) >= 150;
    condCover = solOk && sol.score != null && sol.score >= 80;
    weights = [
      packDim("资产质量(偿付)", sol.score, 0.25, sol.value),
      packDim("护城河", moat.score, 0.25, moat.value),
      packDim("资本(偿付)", sol.score, 0.15, sol.value),
      packDim("派息率", payScore, 0.15, payValue),
      packDim("ROE", roeScore, 0.1, roe3),
      packDim("投资收益趋势", roi.score, 0.1, roi.value),
    ];
  } else if (isBankLike) {
    gaps.push("E类但MAINFINADATA无法识别银行/保险专项字段");
    weights = [
      packDim("资产质量", null, 0.25, null),
      packDim("护城河", moat.score, 0.25, moat.value),
      packDim("核充率", null, 0.15, null),
      packDim("派息率", payScore, 0.15, payValue),
      packDim("ROE", roeScore, 0.1, roe3),
      packDim("净息差", null, 0.1, null),
    ];
    condCover = false;
  } else {
    let fcfScore;
    let fcfValue = null;
    if (!covers.length) {
      fcfScore = null;
      gaps.push("FCF覆盖率缺失（经营现金流/资本开支/分红）");
    } else {
      const c0 = covers[0];
      fcfValue = covers.map((c, i) => `${f10.fcf_cov[i]?.year}:${round(c, 2)}`).join(",");
      if (c0 >= 1.2) fcfScore = 100;
      else if (c0 >= 1.0) fcfScore = 80;
      else if (c0 >= 0.7) fcfScore = 50;
      else fcfScore = 0;
      if (covers.length >= 2 && covers[0] < 0.7 && covers[1] < 0.7) fcfScore = 0;
    }
    const dl = debtLine(cls) ?? 60;
    let debtScore;
    if (debt == null) {
      debtScore = null;
      gaps.push("资产负债率缺失");
    } else if (debt <= dl * 0.8) debtScore = 100;
    else if (debt <= dl) debtScore = 80;
    else if (debt <= dl * 1.1) debtScore = 50;
    else debtScore = 20;

    condCover = Boolean(covers.length) && covers[0] >= 1.0;
    weights = [
      packDim("FCF覆盖", fcfScore, 0.25, fcfValue),
      packDim("护城河", moat.score, 0.25, moat.value),
      packDim("派息率", payScore, 0.15, payValue),
      packDim("ROE", roeScore, 0.15, roe3),
      packDim("PB", pbScore, 0.1, pb),
      packDim("负债率", debtScore, 0.1, debt),
    ];
  }

  const scoreComplete = weights.every((w) => w.score != null);
  let total = null;
  if (scoreComplete) {
    total = Math.round(weights.reduce((s, w) => s + w.score * w.w, 0));
  }

  const condDiv = (fnum(row.div) || 0) >= Number(row.base_div || 0);
  const condPay = pay != null && pay >= lo && pay <= hi;
  const condRoe = roe3 != null && roe3 >= rl;
  const fourN = [condDiv, condPay, condRoe, condCover].filter(Boolean).length;

  if (pay != null && pay > 100) red.push("派息率>100%");
  if (row.cycle_caution && (fnum(row.div) || 0) > 6) {
    red.push("强周期高股息需警惕景气顶部");
  }

  let rating;
  if (!scoreComplete) {
    rating = "⚠️";
  } else if (red.length) rating = "🔴";
  else if (total >= 80 && fourN === 4) rating = "🟢";
  else if (total >= 70 || (total >= 80 && fourN >= 3)) rating = "🟡";
  else if (total >= 60) rating = "🟠";
  else rating = "🔴";

  const bd = bands.D;
  const bw = bands.W;
  const bm = bands.M;
  let signal = "估值分位";
  let action = "观望";
  if (!scoreComplete) {
    signal = "—";
    action = "数据缺口，暂停评级";
  } else if (bd && bw && bm && (bd.bandwidth_pct || 0) >= 5) {
    signal = "布林带";
    const ideal =
      bm.close <= bm.mid &&
      bw.close <= bw.mid - (bw.mid - bw.lower) * 0.3 &&
      bd.close <= bd.mid - (bd.mid - bd.lower) * 0.3;
    if (rating === "🟢" && ideal) action = "建仓";
    else if (rating === "🟢" || rating === "🟡") {
      action = "分批/观望";
      signal = "估值分位（技术位未满足）";
    } else {
      action = rating !== "🔴" ? "持有/观察" : "回避新建仓";
    }
  } else {
    action =
      rating === "🟢" || rating === "🟡"
        ? "分批/观望"
        : rating === "🔴"
          ? "回避新建仓"
          : "观察";
  }

  const ent = entType(f10.controller, f10.holder, f10.org_form);
  let qname = f10.quote?.name || row.name || "";
  qname = String(qname).replace(/^(XD|XR|DR)/, "").replace(/ /g, "");

  const optCandidates = [bw?.upper, bm?.upper].filter((x) => x != null);
  const baseDiv = fnum(row.base_div);
  const targetPrice = divTargetPrice(price, row.div, baseDiv);

  return {
    ...row,
    name: qname || row.name,
    price,
    pb,
    pay_ratio: pay,
    roe3,
    debt,
    controller: f10.controller,
    ent,
    fcf_cov: f10.fcf_cov,
    special: f10.special,
    bands,
    weights,
    total,
    score_complete: scoreComplete,
    rating,
    four: { div: condDiv, pay: condPay, roe: condRoe, cover: condCover, n: fourN },
    red,
    data_gaps: gaps.concat(f10.fetch_ok === false ? ["F10不完整"] : []),
    signal,
    action,
    target_price: targetPrice,
    target_mid_yield: baseDiv,
    tech_target: {
      near: bw?.mid,
      opt: optCandidates.length ? Math.min(...optCandidates) : null,
      note: "后复权口径，不可与现价直接比绝对价",
    },
  };
}

function fetchBands(code, market, session) {
  const out = {};
  for (const [period, klt, lim, win] of [
    ["D", "101", 120, 20],
    ["W", "102", 60, 20],
    ["M", "103", 36, 24],
  ]) {
    try {
      const bars = fetchBrowser(code, market, { klt, limit: lim, session });
      const closes = bars.map((b) => Number(b.close));
      out[period] = bollinger(closes, win);
    } catch (exc) {
      out[period] = null;
      out[`${period}_error`] = String(exc.message || exc);
    }
  }
  return out;
}

function fmt(x, nd = 2) {
  if (x == null) return "—";
  if (typeof x === "number") return x.toFixed(nd);
  return String(x);
}

/** 股息隐含目标价 = (现价×TTM股息率) / 行业基准股息率；无5年中枢时用基准作分母 */
function divTargetPrice(price, divPct, baseDivPct) {
  const p = fnum(price);
  const d = fnum(divPct);
  const mid = fnum(baseDivPct);
  if (p == null || d == null || mid == null || mid <= 0) return null;
  const dps = p * (d / 100);
  return round(dps / (mid / 100), 2);
}

function bandLine(b) {
  if (!b) return "—";
  return `收${fmt(b.close)}/下${fmt(b.lower)}/中${fmt(b.mid)}/上${fmt(b.upper)} 带宽${fmt(b.bandwidth_pct)}%`;
}

function fourTxt(f) {
  return (
    `股息${f.div ? "✅" : "❌"} | 派息${f.pay ? "✅" : "❌"} | ` +
    `ROE${f.roe ? "✅" : "❌"} | 覆盖${f.cover ? "✅" : "❌"}`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      searchCode: "/tmp/buffett_xuangu_search_code.json",
      session: "buffett-kline-report",
      maxKline: "16",
      todayK: "10",
    },
  });
  if (!args.step1 || !args.f10 || !args.bond) {
    console.error(
      "usage: node score_and_report.js --step1 PATH --f10 PATH --bond PATH [--today-k 10] [-o PATH]",
    );
    return 1;
  }

  const step1 = readJsonFile(args.step1);
  const f10Rows = readJsonFile(args.f10);
  const bond = readJsonFile(args.bond);
  const f10By = Object.fromEntries(f10Rows.map((r) => [String(r.code), r]));
  const bondY = Number(bond.yield_pct);
  const xuangu =
    args.xuangu ||
    args["xuangu-result"] ||
    args.searchCode ||
    args["search-code"] ||
    "/tmp/buffett_xuangu_result.json";
  const todayK = Math.max(1, Number(args.todayK || args["today-k"] || 10));
  const maxKline = Math.max(
    todayK,
    Number(args.maxKline || args["max-kline"] || 16),
  );

  let scored = [];
  for (const row of step1.pass || []) {
    const code = String(row.code);
    const f10 = f10By[code] || { fetch_ok: false, code };
    scored.push(scoreOne(row, f10, { D: null, W: null, M: null }));
  }

  let ranked = [...scored].sort(
    (a, b) =>
      (b.score_complete ? 1 : 0) - (a.score_complete ? 1 : 0) ||
      (b.total ?? -1) - (a.total ?? -1) ||
      (b.div || 0) - (a.div || 0),
  );
  for (const r of ranked.slice(0, maxKline)) {
    console.log(`kline ${r.code} ${r.name} ...`);
    const bands = fetchBands(r.code, r.market || "SH", args.session);
    const f10 = f10By[r.code] || { fetch_ok: false };
    Object.assign(r, scoreOne(r, f10, bands));
  }

  /** 今日排队：四条件完整度 → 总分 → 股息/国债比 → 仅同分时央国企先 */
  const soeTie = (ent) => (ent === "中央国企" || ent === "地方国企" ? 0 : 1);
  const pickCmp = (a, b) => {
    const ca = a.score_complete ? 1 : 0;
    const cb = b.score_complete ? 1 : 0;
    if (cb !== ca) return cb - ca;
    const fa = a.four?.n ?? 0;
    const fb = b.four?.n ?? 0;
    if (fb !== fa) return fb - fa;
    const ta = a.total == null ? -1 : a.total;
    const tb = b.total == null ? -1 : b.total;
    if (tb !== ta) return tb - ta;
    const ba = Number(a.bond_ratio ?? a.div ?? 0);
    const bb = Number(b.bond_ratio ?? b.div ?? 0);
    if (bb !== ba) return bb - ba;
    return soeTie(a.ent) - soeTie(b.ent);
  };

  ranked = [...scored].sort(
    (a, b) => pickCmp(a, b) || (b.div || 0) - (a.div || 0),
  );
  const greens = ranked.filter(
    (r) =>
      r.score_complete &&
      r.rating === "🟢" &&
      r.four.n === 4 &&
      !(r.red || []).join("").includes("强周期"),
  );
  let today = [...greens].sort(pickCmp).slice(0, todayK);

  if (today.length < todayK) {
    for (const r of ranked) {
      if (today.some((t) => t.code === r.code)) continue;
      if (
        r.score_complete &&
        (r.rating === "🟢" || r.rating === "🟡")
      ) {
        today.push(r);
      }
      if (today.length >= todayK) break;
    }
  }
  const todayCodes = new Set(today.map((t) => t.code));
  const queue = ranked.filter((r) => !todayCodes.has(r.code)).slice(0, 8);
  const rejected = step1.reject || [];

  const localStamp = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  })();

  const outPath = args.output
    ? args.output
    : path.join(os.homedir(), `Desktop/buffett-报告-${localStamp}.md`);

  const lines = [];
  const L = (s) => lines.push(s);
  L(`# Buffett 高股息验证报告 ${localStamp}`);
  L("");
  L("> 研究框架输出，不构成投资建议。数据来自本轮 opencli + 固化脚本。");
  L("");
  L("## 0. Step0 候选池");
  L(`- Step0 来源：\`xuangu-result-dom\`（\`${xuangu}\`）`);
  L(`- N=${step1.n_pool} → M=${step1.n_pass}（剔除 ${step1.n_reject}）`);
  L(`- 国债：${bond.source} = **${bondY}%**（${bond.fetched_at}）`);
  L("- K线：`fetch_kline_hfq.js`（push2his fqt=2 / adapter）+ 布林自算");
  L(
    "- 目标价：`(现价×TTM股息率)÷行业基准股息率`（无近5年股息中位数时用行业基准作分母）",
  );
  L("");
  L("## 1. 今日推荐一览");
  L("");
  L(
    `条件选股 N=${step1.n_pool} → 硬门槛过 M=${step1.n_pass} → ` +
      `今日推荐 K=${today.length} | 排队 Q=${queue.length}`,
  );
  L("");
  L("| 代码 | 简称 | 评级 | 现价 | 信号来源 | 本次操作 | 建议仓位 | 目标价 |");
  L("|---|---|---|---|---|---|---|---|");
  for (const r of today) {
    const posHint =
      r.action.includes("分批") || r.signal.includes("估值分位")
        ? "≤5%分批"
        : r.action.includes("建仓")
          ? "≤15%"
          : "—";
    L(
      `| ${r.code} | ${r.name} | ${r.rating}${r.total ?? "缺口"} | ${fmt(r.price)} | ` +
        `${r.signal} | ${r.action} | ${posHint} | ${fmt(r.target_price)} |`,
    );
  }
  L("");
  L(
    "排队：" +
      queue.map((q) => `${q.code}${q.name}(${q.rating}${q.total})`).join("；"),
  );
  L("");
  L("## 2. 个股短评（今日推荐）");
  L("");
  for (const r of today) {
    L(`### ${r.code} ${r.name}`);
    L("");
    L("**分析摘要**");
    L(`- 质地：${r.ind_name} / ${r.ent}（实控人：${r.controller || "—"}）`);
    L(
      `- 股息 ${fmt(r.div)}% ；派息 ${fmt(r.pay_ratio)}% ；ROE3 ${fmt(r.roe3)}% ；` +
        `股息/国债 ${fmt(r.bond_ratio)}x`,
    );
    L(`- 四条件：${fourTxt(r.four)}；红线：${(r.red || []).join("；") || "无"}`);
    L(
      `- 技术：日 ${bandLine(r.bands?.D)}；周 ${bandLine(r.bands?.W)}；月 ${bandLine(r.bands?.M)}`,
    );
    L(
      `- **目标价 ${fmt(r.target_price)}**（每股分红≈${fmt((r.price || 0) * (r.div || 0) / 100, 3)} ÷ 行业基准 ${fmt(r.target_mid_yield)}%）`,
    );
    L("");
    L(`**操作**：${r.action}（${r.signal}）`);
    L("");
    L(
      "**巴菲特视角**：优先看护城河与分红可持续；未到多周期下轨共振前，只用估值分位小步试探。",
    );
    L("");
    L("**主要风险**：行业景气/政策；派息与 ROE 回落；技术位未到时过早加仓。");
    L("");
  }

  L("## 3. 附录");
  L("");
  L("### 3.1 硬门槛剔除");
  L("");
  L("| 代码 | 简称 | 原因 |");
  L("|---|---|---|");
  for (const r of rejected) {
    L(`| ${r.code} | ${r.name} | ${(r.reject_reasons || []).join(",")} |`);
  }
  L("");
  L("### 3.2 过门槛详报");
  L("");
  for (const r of ranked) {
    L(`#### ${r.code} ${r.name}`);
    L(
      `评级 ${r.rating}${r.total ?? "缺口"} | ${r.ent} | ${r.ind_name} | ` +
        `现价 ${fmt(r.price)} | 股息 ${fmt(r.div)}%`,
    );
    L(`四条件：${fourTxt(r.four)}；动作：${r.action}；信号：${r.signal}`);
    L(
      `派息 ${fmt(r.pay_ratio)}% | ROE3 ${fmt(r.roe3)}% | 实控人 ${r.controller || "—"}`,
    );
    if (r.special?.kind) {
      const y0 = (r.special.years || [])[0] || {};
      L(
        `专项(${r.special.kind})：` +
          (r.special.kind === "bank"
            ? `不良${fmt(y0.npl)}% / 拨备${fmt(y0.provision)}% / 核充${fmt(y0.cet1)}% / 净息差${fmt(y0.nim)}%`
            : `偿付${fmt(y0.solvency)}% / 投资收益${fmt(y0.net_roi)}%`),
      );
    }
    if (r.data_gaps?.length) L(`缺口：${r.data_gaps.join("；")}`);
    L("");
    L("| 维度 | 数值 | 得分 | 权重 | 贡献 |");
    L("|---|---|---|---|---|");
    for (const w of r.weights || []) {
      L(
        `| ${w.dim} | ${w.value ?? "—"} | ${w.score ?? "—"} | ${Math.round(w.w * 100)}% | ${w.contrib ?? "—"} |`,
      );
    }
    L("");
    L(
      `日 ${bandLine(r.bands?.D)}；周 ${bandLine(r.bands?.W)}；月 ${bandLine(r.bands?.M)}`,
    );
    L("");
  }

  L(`生成时间：${new Date().toISOString().replace(/\.\d{3}Z$/, "")}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`REPORT=${outPath}`);
  console.log(`TODAY=${today.map((t) => `${t.code}:${t.rating}${t.total}`).join(",")}`);
  return 0;
}

process.exit(main());
