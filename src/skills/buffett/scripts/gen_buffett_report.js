#!/usr/bin/env node
/**
 * 桌面终报骨架：读 Step2 事实卡 JSON，写目录 ~/Desktop/buffett-YYYYMMDDHHmm/
 *
 * 分册（避免单文件过长）：
 *   00-总览.md     — 今日建仓建议 + 分册目录
 *   1x–7x-*.md    — 按评分模板 kind 分册；册内仍按东财三级行业分组、组内分数降序
 *   99-硬筛剔除.md
 *
 * 「巴菲特交叉验证」「主要风险」留空位，由 Agent 按 Buffett 视角逐票现写。
 *
 * 用法:
 *   node gen_buffett_report.js
 *   node gen_buffett_report.js --facts ~/Desktop/temp/buffett_step2_facts.json --step1 ~/Desktop/temp/buffett_step1.json
 *   node gen_buffett_report.js --out-dir ~/Desktop/buffett-自定义
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatDimAnchor, formatScoreAnchorFooter } from "./anchor_display.js";
import { peerMeta } from "./industry_map.js";
import {
  buildIndustryBacktest,
  industryDisplayKey,
  renderIndustryBacktestBlock,
} from "./peer_returns_hfq.js";
import { buffettTmp, buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";
import { WEIGHTS, assignPeerRanks, formatPeerRank } from "./score_numeric.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(x, nd = 2) {
  if (x == null) return "—";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : x.toFixed(nd);
  return String(x);
}

function fmtYi(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function dimValueText(d) {
  if (d.value == null) return "—";
  if (d.id === "dividend_discipline") {
    return `${d.value.years ?? "—"}年｜下调${d.value.cuts ?? "—"}次`;
  }
  if (d.id === "nim_trend") {
    if (d.value && typeof d.value === "object") {
      return `NIM ${fmt(d.value.nim)}%｜两年${fmt(d.value.chg)}pct`;
    }
    return fmt(d.value);
  }
  if (d.id === "npl_formation") return `${fmt(d.value, 3)}%`;
  if (d.id === "npl_gap") return `${fmt(d.value, 1)}%`;
  if (d.id === "nonint") return `${fmt(d.value, 1)}%`;
  if (d.id === "roe_stability") {
    return `CV=${fmt(d.value.cv)}`;
  }
  if (typeof d.value === "object") {
    if (d.value.npl != null) return `不良${d.value.npl}%｜拨备${d.value.provision}%`;
    return Object.entries(d.value)
      .filter(([, v]) => typeof v !== "object")
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" ");
  }
  return fmt(d.value);
}

function dimOrder(kind) {
  return Object.keys(WEIGHTS[kind] || WEIGHTS.corp);
}

function dimRows(card) {
  const score = card.score;
  if (!score?.dims) return [];
  return dimOrder(score.kind)
    .map((id) => score.dims[id])
    .filter(Boolean)
    .map((d) => {
      const val = dimValueText(d);
      const extra = d.pct != null ? `（分位${Math.round(d.pct)}）` : "";
      return {
        label: d.label,
        val: extra && !val.includes("分位") ? `${val}${extra}` : val,
        anchor: formatDimAnchor(d.id, industryAnchorText(card)),
        score: d.score == null ? "—" : d.score,
        w: Math.round(d.weight * 100),
        contrib: d.score == null ? "—" : (d.score * d.weight).toFixed(1),
      };
    });
}

function taxDiv(div) {
  if (div == null) return "—";
  return `TTM ${div}%｜持股>1年免税；≤1年税后约 ${(div * 0.9).toFixed(2)}% / ${(div * 0.8).toFixed(2)}%`;
}

function isForwardAdjustedKline(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return payload.fqt === 1 || payload.adjust === "forward" || payload.adj === "forward";
}

function resolveTechKlinePath(tmpDir, code, period) {
  const qfqPath = path.join(tmpDir, `${code}_${period}_qfq.json`);
  if (fs.existsSync(qfqPath)) return qfqPath;

  const legacyPath = path.join(tmpDir, `${code}_${period}.json`);
  if (!fs.existsSync(legacyPath)) return null;
  try {
    const legacy = readJsonFile(legacyPath);
    return isForwardAdjustedKline(legacy) ? legacyPath : null;
  } catch {
    return null;
  }
}

function loadBoll(tmpDir, code) {
  const result = { D: null, W: null, M: null };
  for (const [p, key] of [
    ["day", "D"],
    ["week", "W"],
    ["month", "M"],
  ]) {
    // 今日技术位只用前复权：优先 *_qfq.json；旧路径 *.json 必须显式校验为前复权
    const klinePath = resolveTechKlinePath(tmpDir, code, p);
    if (!klinePath) continue;
    try {
      const out = execFileSync("node", [path.join(HERE, "calc_bollinger.js"), klinePath], {
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      result[key] = parsed.bands?.[key] || null;
    } catch {
      const bollCandidates = [
        path.join(tmpDir, `${code}_${p}_qfq_boll.json`),
        path.join(tmpDir, `${code}_${p}_boll.json`),
      ];
      const bollPath = bollCandidates.find((p0) => fs.existsSync(p0));
      if (bollPath) {
        const parsed = JSON.parse(fs.readFileSync(bollPath, "utf8"));
        result[key] = parsed.bands?.[key] || null;
      }
    }
  }
  return result;
}

/** 相对半带宽：-1=下轨，0=中轨，+1=上轨。跌破下轨 < -1，升破上轨 > 1。 */
function bandRelFromMid(b) {
  const close = b?.close;
  const mid = b?.mid;
  const upper = b?.upper;
  const lower = b?.lower;
  if (![close, mid, upper, lower].every(Number.isFinite)) return null;
  if (close >= mid) {
    const half = upper - mid;
    if (!(half > 0)) return close > mid ? Infinity : 0;
    return (close - mid) / half;
  }
  const half = mid - lower;
  if (!(half > 0)) return close < mid ? -Infinity : 0;
  return (close - mid) / half;
}

/** 所有边界松弛统一为相对参考价 ≤5%（不再用半带宽 1/4）。 */
const PRICE_SLACK = 0.05;

/**
 * 技术位 PE/PB 绝对值闸门（按评分模板分档；不分位、不比自身年末史、不比同行）。
 * 只拦今日新开仓。默认与旧统一门槛 PE<20 / PB<2 对齐；金融更紧、品牌/科技更松。
 */
export const VAL_ABS_BY_KIND = {
  bank: { pe: 12, pb: 1.0 },
  insurance: { pe: 15, pb: 1.5 },
  broker: { pe: 15, pb: 1.5 },
  utility: { pe: 20, pb: 2.5 },
  resource_cycle: { pe: 18, pb: 2.5 },
  infra_construction: { pe: 15, pb: 1.5 },
  equip_mfg: { pe: 22, pb: 2.5 },
  appliance: { pe: 20, pb: 3.5 },
  brand_consumer: { pe: 22, pb: 4.5 },
  tech_hardware: { pe: 25, pb: 5.0 },
  /** corp 及其他未列模板 */
  corp: { pe: 20, pb: 2.0 },
};

const VAL_ABS_DEFAULT = VAL_ABS_BY_KIND.corp;

function valAbsCutsForKind(kind) {
  return VAL_ABS_BY_KIND[kind] || VAL_ABS_DEFAULT;
}

function validPe(x) {
  return Number.isFinite(x) && x > 0 && x < 200;
}

function validPb(x) {
  return Number.isFinite(x) && x > 0 && x < 30;
}

/**
 * 买入当天行情 PE/PB 绝对值。按模板分档：≥门槛 → 偏贵。两维都缺 → 观望。
 * 评分表里的 PE/PB 同类分位不受影响。
 */
function valuationSnapshot(card) {
  const kind = card?.score?.kind || "corp";
  const cuts = valAbsCutsForKind(kind);
  const pe = validPe(card.pe) ? card.pe : null;
  const pb = validPb(card.pb) ? card.pb : null;
  const canPe = pe != null;
  const canPb = pb != null;
  const peHigh = canPe && pe >= cuts.pe;
  const pbHigh = canPb && pb >= cuts.pb;
  const missing = !canPe && !canPb;
  return {
    pe,
    pb,
    peCut: cuts.pe,
    pbCut: cuts.pb,
    kind,
    peHigh,
    pbHigh,
    canPe,
    canPb,
    wait: missing || peHigh || pbHigh,
    missing,
  };
}

function valLegText(name, cur, cut, high, can) {
  if (!can) return `${name} —（行情缺失）`;
  return `${name} ${fmt(cur, 2)}${high ? `≥${fmt(cut, 2)}偏贵` : `<${fmt(cut, 2)}未偏贵`}`;
}

function valLine(v) {
  if (!v) return "";
  const kindHint = v.kind && v.kind !== "corp" ? `｜模板${v.kind}` : "";
  const flag = v.wait ? "（绝对值偏贵或缺失，拦新开仓）" : "（绝对值未偏贵）";
  return `买入估值（PE/PB绝对值·按模板分档，不分位）：${valLegText("PE", v.pe, v.peCut, v.peHigh, v.canPe)}｜${valLegText("PB", v.pb, v.pbCut, v.pbHigh, v.canPb)}${kindHint}${flag}`;
}

function expensiveValSignal(v) {
  if (v.missing) return "周下+月中～下已到位，但行情PE/PB缺失，观望（无法确认绝对值偏低）";
  const bits = [];
  if (v.peHigh) bits.push(`PE ${fmt(v.pe, 2)}≥${fmt(v.peCut, 2)}`);
  if (v.pbHigh) bits.push(`PB ${fmt(v.pb, 2)}≥${fmt(v.pbCut, 2)}`);
  return `周下+月中～下已到位，但${bits.join("、")}偏贵，观望（高估值更不抗跌，非卖出）`;
}

function expensiveValAction(v) {
  if (v.missing) {
    return (
      "观望：布林周下+月中～下已到位，但行情PE/PB缺失，无法确认买入时绝对值偏低。" +
      "只拦新开仓，不是卖出。评分表PE/PB分位未改。"
    );
  }
  const bits = [];
  if (v.peHigh) bits.push(`PE ${fmt(v.pe, 2)}≥${fmt(v.peCut, 2)}`);
  if (v.pbHigh) bits.push(`PB ${fmt(v.pb, 2)}≥${fmt(v.pbCut, 2)}`);
  return (
    `观望：布林周下+月中～下已到位，但${bits.join("；")}，绝对值偏贵。` +
    `只拦新开仓，不是卖出。评分表PE/PB分位未改。`
  );
}

function pricePctFrom(close, ref) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return null;
  return (close - ref) / ref;
}

/** ≤ 轨，或最多高出参考价 PRICE_SLACK。 */
function isAtOrWithinAbove(close, ref, slack = PRICE_SLACK) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return false;
  if (close <= ref) return true;
  return (close - ref) / ref <= slack;
}

/** ≥ 轨，或最多低于参考价 PRICE_SLACK。 */
function isAtOrWithinBelow(close, ref, slack = PRICE_SLACK) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return false;
  if (close >= ref) return true;
  return (ref - close) / ref <= slack;
}

/** 周线下轨附近：≤下轨，或相对下轨价高出 ≤5%。 */
function isWeekNearLow(bW) {
  return isAtOrWithinAbove(bW?.close, bW?.lower);
}

/**
 * 月线中轨～下轨：落在 [下轨×(1−5%), 中轨×(1+5%)]。
 * 略高中轨、略低下轨均只允许股价 5% 内。
 */
function isMonthMidToLow(bM) {
  const close = bM?.close;
  const mid = bM?.mid;
  const lower = bM?.lower;
  if (![close, mid, lower].every(Number.isFinite) || !(mid > 0) || !(lower > 0)) return false;
  return isAtOrWithinAbove(close, mid) && isAtOrWithinBelow(close, lower);
}

function zoneLabel(b) {
  if (!b?.ok) return b?.error || "无法计算";
  if (b.bandwidth_pct != null && b.bandwidth_pct < 5) return `带宽${b.bandwidth_pct}%（<5%观望）`;
  const pos = bandRelFromMid(b);
  if (isWeekNearLow(b) || (Number.isFinite(b.close) && Number.isFinite(b.lower) && b.close <= b.lower)) {
    return "下轨附近";
  }
  if (b.close >= b.upper) return "上轨附近";
  if (isMonthMidToLow(b) && pos != null && pos <= PRICE_SLACK) return "中～下轨";
  if (pos != null && pos <= 0) return "中～下轨";
  if (isAtOrWithinAbove(b.close, b.mid) && pos > 0) return "中轨附近（略上≤5%）";
  if (b.close > b.mid && b.close < b.upper) return "中～上轨";
  return "中轨附近";
}

/** 周下 + 月中～月下（边界一律股价 5%），且买入时 PE/PB 未偏贵。日线不进建仓门槛。 */
function bollSignal(bD, bW, bM, val) {
  if (!bW?.ok || !bM?.ok) {
    return { signal: "K线不足，观望", batchOk: false, weekResonance: false };
  }
  // 带宽闸门：周线优先；无周带宽时退回日线（若有）
  const bw = bW.bandwidth_pct ?? bD?.bandwidth_pct;
  if (bw != null && bw < 5) {
    return { signal: "周线带宽<5%，观望", batchOk: false, weekResonance: false };
  }
  const weekNearLow = isWeekNearLow(bW);
  const monthMidLow = isMonthMidToLow(bM);
  if (weekNearLow && monthMidLow) {
    if (val?.wait) {
      return {
        signal: expensiveValSignal(val),
        actionRemark: expensiveValAction(val),
        batchOk: false,
        weekResonance: true,
        expensiveVal: true,
      };
    }
    return {
      signal: "可尝试批量建仓（周下+月中～下）",
      batchOk: true,
      weekResonance: true,
    };
  }
  if (!weekNearLow) return { signal: "周线未到下轨附近", batchOk: false, weekResonance: false };
  if (!monthMidLow) {
    const aboveMid = Number.isFinite(bM.close) && Number.isFinite(bM.mid) && bM.close > bM.mid * (1 + PRICE_SLACK);
    return {
      signal: aboveMid ? "月线高于中轨（>5%），未到买点" : "月线未落在中～下轨（边界5%）",
      batchOk: false,
      weekResonance: true,
    };
  }
  return { signal: "观望", batchOk: false, weekResonance: false };
}

function techBlock(boll, val) {
  const fmtB = (b, name) => {
    if (!b?.ok) return `${name}：${b?.error || "无法计算"}`;
    return `${name}：收盘(前复权)${b.close}｜中轨${b.mid}｜上${b.upper}｜下${b.lower}｜带宽${b.bandwidth_pct}%｜${zoneLabel(b)}`;
  };
  const sig = bollSignal(boll.D, boll.W, boll.M, val);
  const near = boll.W?.mid;
  const opt =
    boll.W?.upper != null && boll.M?.upper != null
      ? Math.min(boll.W.upper, boll.M.upper)
      : boll.W?.upper ?? boll.M?.upper;
  const text = [
    fmtB(boll.D, "日线"),
    fmtB(boll.W, "周线"),
    fmtB(boll.M, "月线"),
    valLine(val),
    `信号来源：布林带｜结论：${sig.signal}`,
    `K 线来源：前复权（*_qfq / fqt=1；回测校准用 *_hfq 后复权，不进买卖），as_of=${boll.D?.as_of || "—"}`,
    near != null
      ? `技术目标（前复权轨）：近端=周中轨 ${near}；乐观=周/月上轨更保守者 ${fmt(opt)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, sig };
}

/** 写入今日建仓建议：全样本同业第1 + 布林到位 + 无 hard 红线 + 非⚠️。 */
function hasHardRed(card) {
  return Array.isArray(card.red_hints) && card.red_hints.length > 0;
}

function industryGroupKey(card) {
  return industryDisplayKey(card);
}

function industryAnchorText(card) {
  const m = peerMeta(card);
  return [m.label, card.f100].filter(Boolean).join(" ");
}

function isScoreGap(card) {
  return !card.score?.numeric_ok || card.score?.total == null;
}

/** 全样本（硬筛池 M）内同三级行业加权总分第 1（并列共享名次亦算）。 */
function isPeerChampion(card) {
  return card.score?.rank === 1 && !isScoreGap(card);
}

function rankLabel(card) {
  return formatPeerRank(card.score);
}

function canSuggestToday(card, sig) {
  if (!sig?.batchOk) return false;
  if (hasHardRed(card)) return false;
  if (isScoreGap(card)) return false;
  if (!isPeerChampion(card)) return false;
  return true;
}

/** 候补：布林到位 + 无 hard/⚠️，但非全样本同业第1（不进今日建仓，单独列表）。 */
function canBeAlternate(card, sig) {
  if (!sig?.batchOk) return false;
  if (hasHardRed(card)) return false;
  if (isScoreGap(card)) return false;
  if (isPeerChampion(card)) return false;
  return true;
}

function pickIndustryWinners(rows) {
  const byInd = new Map();
  for (const row of rows) {
    const key = industryGroupKey(row.c);
    const prev = byInd.get(key);
    if (!prev) {
      byInd.set(key, row);
      continue;
    }
    const ta = row.c.score?.total ?? -1;
    const tb = prev.c.score?.total ?? -1;
    if (ta > tb) {
      byInd.set(key, row);
      continue;
    }
    if (ta < tb) continue;
    const wr = Number(row.sig.weekResonance) - Number(prev.sig.weekResonance);
    if (wr > 0) byInd.set(key, row);
    else if (wr === 0 && (row.c.bond_ratio || 0) > (prev.c.bond_ratio || 0)) byInd.set(key, row);
  }
  return [...byInd.values()];
}

function rankTodayWinners(a, b) {
  return (
    Number(b.sig.weekResonance) - Number(a.sig.weekResonance) ||
    (b.c.bond_ratio || 0) - (a.c.bond_ratio || 0) ||
    String(a.c.code).localeCompare(String(b.c.code))
  );
}

function actionBlock(card, sig, { inToday } = {}) {
  if (inToday) {
    return "建仓建议（全样本同业第1 + 布林到位：周下+月中～下，买入时PE/PB未偏贵）";
  }
  if (sig.expensiveVal) {
    return sig.actionRemark || `观望：${sig.signal}`;
  }
  if (sig.batchOk && hasHardRed(card)) {
    return `观望：布林到位，hard红线不入今日建议：${card.red_hints.join("；")}。`;
  }
  if (sig.batchOk && isScoreGap(card)) {
    return "观望：布林到位，数据缺口不入今日建议。";
  }
  if (sig.batchOk && !isPeerChampion(card)) {
    return "观望／候补：布林到位，但非全样本同业第1（见总览候补名单；禁止替补入今日建仓）。";
  }
  if (isScoreGap(card)) return `观望：${sig.signal}。数据缺口，暂停终评。`;
  if (hasHardRed(card)) return `观望：${sig.signal}。hard红线：${card.red_hints.join("；")}。`;
  return `观望：${sig.signal}`;
}

function redReview(card) {
  const hard = card.red_hints || [];
  const soft = card.soft_hints || [];
  if (!hard.length && !soft.length) return "无 hard/soft 提示；复核通过。";
  return `hard=${hard.join("；") || "无"}；soft=${soft.join("；") || "无"}。Agent 复核 hard 提示后定终评。`;
}

function scoreTable(card) {
  const rows = dimRows(card);
  const total = card.score?.total ?? "—";
  const footer = formatScoreAnchorFooter(card.score, card.f100);
  const L = [
    "| 维度 | 数值 | 对照说明 | 得分(0-100) | 权重 | 加权贡献 |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    L.push(`| ${r.label} | ${r.val} | ${r.anchor} | ${r.score} | ${r.w}% | ${r.contrib} |`);
  }
  L.push(`| **合计** | — | ${footer} | — | 100% | **${total}${card.score?.rating && card.score.rating !== "⚠️" ? `｜${card.score.rating}` : ""}** |`);
  return L.join("\n");
}

/** 分册顺序：金融 → 公用/基建 → 周期 → 制造/消费 → 科技；未列 kind 归「其他」。 */
const KIND_VOLUMES = [
  { kind: "bank", file: "10-银行.md", title: "银行" },
  { kind: "insurance", file: "11-保险.md", title: "保险" },
  { kind: "broker", file: "12-证券.md", title: "证券" },
  { kind: "utility", file: "20-公用事业.md", title: "公用事业" },
  { kind: "infra_construction", file: "21-基建建设.md", title: "基建建设" },
  { kind: "resource_cycle", file: "30-资源周期.md", title: "资源周期" },
  { kind: "equip_mfg", file: "40-装备制造.md", title: "装备制造" },
  { kind: "appliance", file: "50-家电.md", title: "家电" },
  { kind: "brand_consumer", file: "60-品牌消费.md", title: "品牌消费" },
  { kind: "tech_hardware", file: "70-科技硬件.md", title: "科技硬件" },
  { kind: "corp", file: "80-其他.md", title: "其他（corp 兜底）" },
];

function kindVolumeMeta(kind) {
  return KIND_VOLUMES.find((v) => v.kind === kind) || KIND_VOLUMES[KIND_VOLUMES.length - 1];
}

function safeFileStem(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}

function groupByIndustrySorted(cardList) {
  function scoreDesc(a, b) {
    return (
      (b.score?.total ?? -1) - (a.score?.total ?? -1) ||
      (b.bond_ratio || 0) - (a.bond_ratio || 0) ||
      String(a.code).localeCompare(String(b.code))
    );
  }
  const byIndustry = new Map();
  for (const c of cardList) {
    const key = industryGroupKey(c);
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key).push(c);
  }
  for (const list of byIndustry.values()) list.sort(scoreDesc);
  return [...byIndustry.entries()].sort((a, b) => {
    const maxA = a[1][0]?.score?.total ?? -1;
    const maxB = b[1][0]?.score?.total ?? -1;
    return maxB - maxA || a[0].localeCompare(b[0], "zh");
  });
}

function renderStockCard(c, { bollCache, valCache, todayCodes }) {
  const L = [];
  const rank = rankLabel(c);
  const total = c.score?.total ?? "—";
  L.push(`#### ${c.code} ${c.name}（${rank}｜加权${total}分）`);
  L.push("");
  L.push(
    `**基础信息**：市值 ${fmtYi(c.mkt_yi)} 亿；东财 f100=${c.f100}${c.industry_f10?.l3 ? `；三级=${c.industry_f10.l3}` : ""}；现价 ${c.price}；${taxDiv(c.div)}；股息/国债比 ${fmt(c.bond_ratio, 2)}；连续现金分红 ${c.div_streak} 年。`,
  );
  L.push("");
  L.push("**评分表**（全部采用脚本结果）：");
  L.push("");
  L.push(scoreTable(c));
  L.push("");
  L.push(`**红线**：${redReview(c)}`);
  L.push(`**行业排名**：${rank}（脚本总分 ${total}）。`);
  L.push("");
  const boll = bollCache[c.code] || { D: null, W: null, M: null };
  const { text: techText, sig } = techBlock(boll, valCache[c.code]);
  L.push("**技术位**：");
  L.push(techText);
  L.push("");
  L.push(`**预期目标价**：${boll.D?.ok ? "见技术位（操作采用技术档）" : "—"}`);
  L.push("");
  L.push(`**操作**：${actionBlock(c, sig, { inToday: todayCodes.has(c.code) })}`);
  L.push("");
  L.push("**巴菲特交叉验证**：（Agent 按 Buffett 视角现写，2–4 句）");
  L.push("");
  L.push("**主要风险**：（Agent 现写 1–3 条，须对本票特异）");
  L.push("");
  return L;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      step1: buffettTmp("buffett_step1.json"),
      xuangu: buffettTmp("buffett_xuangu_result.json"),
      tmp: buffettTmpDir(),
      months: "36",
    },
  });

  const data = readJsonFile(args.facts);
  const step1 = readJsonFile(args.step1);
  const xuangu = fs.existsSync(args.xuangu) ? readJsonFile(args.xuangu) : { source: "—" };
  const cards = [...(data.cards || [])];
  assignPeerRanks(cards);
  const backtestMonths = Number(args.months) || 36;
  const industryBacktest = buildIndustryBacktest(cards, args.tmp, { months: backtestMonths });

  const bollCache = {};
  const sigCache = {};
  const valCache = {};
  for (const c of cards) {
    const boll = loadBoll(args.tmp, c.code);
    const val = valuationSnapshot(c);
    bollCache[c.code] = boll;
    valCache[c.code] = val;
    sigCache[c.code] = bollSignal(boll.D, boll.W, boll.M, val);
  }

  const eligible = cards
    .filter((c) => canSuggestToday(c, sigCache[c.code]))
    .map((c) => ({ c, sig: sigCache[c.code], boll: bollCache[c.code] }));
  const industryWinners = pickIndustryWinners(eligible);
  const todayBuys = [...industryWinners].sort(rankTodayWinners);

  const todayCodes = new Set(todayBuys.map(({ c }) => c.code));
  const alternates = cards
    .filter((c) => canBeAlternate(c, sigCache[c.code]))
    .map((c) => ({ c, sig: sigCache[c.code], boll: bollCache[c.code] }))
    .sort(
      (a, b) =>
        (b.c.score?.total ?? -1) - (a.c.score?.total ?? -1) ||
        (a.c.score?.rank ?? 99) - (b.c.score?.rank ?? 99) ||
        String(a.c.code).localeCompare(String(b.c.code)),
    );
  const A = alternates.length;

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const outDir =
    args["out-dir"] ||
    args.output ||
    path.join(process.env.HOME, "Desktop", `buffett-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const K = todayBuys.length;

  /** kind → cards */
  const byKind = new Map();
  for (const c of cards) {
    const kind = c.score?.kind || "corp";
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(c);
  }

  const volumeRows = [];
  for (const vol of KIND_VOLUMES) {
    const list = byKind.get(vol.kind) || [];
    if (!list.length && vol.kind !== "corp") continue;
    if (!list.length) continue;
    const industryGroups = groupByIndustrySorted(list);
    const buysInVol = todayBuys.filter(({ c }) => (c.score?.kind || "corp") === vol.kind).length;
    volumeRows.push({
      ...vol,
      n: list.length,
      buys: buysInVol,
      industryGroups,
      list,
    });
  }
  // orphan kinds not in KIND_VOLUMES
  for (const [kind, list] of byKind) {
    if (KIND_VOLUMES.some((v) => v.kind === kind)) continue;
    if (!list.length) continue;
    const meta = kindVolumeMeta(kind);
    const file = `${meta.file.replace(/\.md$/, "")}-${safeFileStem(kind)}.md`;
    volumeRows.push({
      kind,
      file,
      title: `${meta.title}·${kind}`,
      n: list.length,
      buys: todayBuys.filter(({ c }) => (c.score?.kind || "corp") === kind).length,
      industryGroups: groupByIndustrySorted(list),
      list,
    });
  }

  const codeToVolFile = new Map();
  for (const vol of volumeRows) {
    for (const c of vol.list) codeToVolFile.set(c.code, vol.file);
  }

  // —— 00 总览 ——
  const overview = [];
  overview.push("# A股高股息长线复利 · 今日总览");
  overview.push("");
  overview.push(`生成时点：${now.toISOString()}｜研究框架，不构成投资建议。`);
  overview.push(
    `国债10Y：${data.bond.yield_pct}%（${data.bond.source}，${data.bond.fetched_at}）｜股息门槛：≥国债×2 = ${(data.bond.yield_pct * 2).toFixed(2)}%`,
  );
  overview.push(
    `候选池：N=${step1.n_pool}（${xuangu.source || "xuangu-result-dom"}）→ 硬筛通过 M=${step1.n_pass} → 今日建仓建议 K=${K}｜候补 A=${A}`,
  );
  overview.push("");
  overview.push(
    "本套报告按**评分模板**拆成多册（册内仍按东财三级行业分组）。每票只写一份完整分析，不另开短评/详报两套。",
  );
  overview.push("");
  overview.push(`## 1. 今日建仓建议一览（K=${K}）`);
  overview.push("");
  overview.push(
    "条件：「全样本同业第1（硬筛池 M 内同三级行业总分第1，并列共享）+ 布林到位 + 买入时PE/PB未偏贵（按模板分档）+ 无 hard 红线/⚠️」——宁缺毋滥，允许 K=0。跨行业不比总分。",
  );
  overview.push("");
  if (K === 0) {
    overview.push(
      "**今日无建仓建议**：无票同时满足「全样本同业第1 + 周线下轨附近 + 月线中～下轨（边界均≤股价5%）+ 买入时PE/PB未偏贵 + 无 hard 红线」。",
    );
    overview.push("");
  }
  overview.push("| 代码 | 简称 | 行业排名 | 现价 | TTM股息率 | 信号来源 | 本次操作 | 分册 |");
  overview.push("|---|---|---|---|---|---|---|---|");
  if (K === 0) {
    overview.push("| — | — | — | — | — | — | 今日无建仓建议 | — |");
  } else {
    for (const { c } of todayBuys) {
      const total = c.score?.total ?? "—";
      const volFile = codeToVolFile.get(c.code) || "—";
      overview.push(
        `| ${c.code} | ${c.name} | ${rankLabel(c)}（${total}分） | ${c.price} | ${c.div}% | 布林带 | 建仓建议（全样本同业第1+布林） | [${volFile}](${volFile}) |`,
      );
    }
  }
  overview.push("");
  overview.push(`## 1b. 候补名单（A=${A}）`);
  overview.push("");
  overview.push(
    "条件：「布林到位（周下+月中～下，买入时PE/PB未偏贵）+ 无 hard 红线/⚠️」，但**非**全样本同业总分第1。完整表见 [01-候补名单.md](01-候补名单.md)。**不得**替补入上方今日建仓建议。",
  );
  overview.push("");
  if (A === 0) {
    overview.push("今日无候补票。");
    overview.push("");
  } else {
    overview.push("| 代码 | 简称 | 行业排名 | 现价 | TTM股息率 | 信号来源 | 备注 | 分册 |");
    overview.push("|---|---|---|---|---|---|---|---|");
    for (const { c } of alternates.slice(0, 20)) {
      const total = c.score?.total ?? "—";
      const volFile = codeToVolFile.get(c.code) || "—";
      overview.push(
        `| ${c.code} | ${c.name} | ${rankLabel(c)}（${total}分） | ${c.price} | ${c.div}% | 布林带 | 非同业第1·候补 | [${volFile}](${volFile}) |`,
      );
    }
    if (A > 20) {
      overview.push(`| … | … | 另有 ${A - 20} 只 | — | — | — | 见完整候补名单 | [01-候补名单.md](01-候补名单.md) |`);
    }
    overview.push("");
  }
  overview.push("## 2. 分册目录");
  overview.push("");
  overview.push("| 分册 | 模板 | 只数 | 今日建仓 |");
  overview.push("|---|---|---:|---:|");
  for (const vol of volumeRows) {
    overview.push(`| [${vol.file}](${vol.file}) | ${vol.title}（\`${vol.kind}\`） | ${vol.n} | ${vol.buys} |`);
  }
  overview.push(`| [01-候补名单.md](01-候补名单.md) | 布林到位但非同业第1 | ${A} | — |`);
  overview.push(`| [99-硬筛剔除.md](99-硬筛剔除.md) | 硬门槛未过 | ${step1.n_reject ?? (step1.reject || []).length} | — |`);
  overview.push("");
  overview.push("阅读建议：先看本总览建仓表 → 候补名单（可选）→ 点开对应分册核对评分/技术位/巴菲特交叉验证。");
  overview.push("");
  fs.writeFileSync(path.join(outDir, "00-总览.md"), overview.join("\n"), "utf8");

  // —— 01 候补 ——
  const altDoc = [];
  altDoc.push("# 候补名单（非同业评分第1）");
  altDoc.push("");
  altDoc.push(`← [00-总览.md](00-总览.md)｜生成时点 ${now.toISOString()}`);
  altDoc.push("");
  altDoc.push(
    "本表收录：**布林到位**（周线下轨附近 + 月线中～下轨，边界≤5%；买入时 PE/PB 按模板未偏贵）+ **无 hard 红线 / ⚠️**，但加权总分**不是**该东财三级行业全样本第1 的票。",
  );
  altDoc.push("");
  altDoc.push(
    "用途：技术买点已出现的次优质地观察池。官方今日建仓仍只认同业第1；**禁止**用本表替补未到位的冠军。",
  );
  altDoc.push("");
  altDoc.push(`A=${A}`);
  altDoc.push("");
  altDoc.push("| 代码 | 简称 | 行业排名 | 三级行业 | 现价 | TTM股息率 | 模板 | 分册 |");
  altDoc.push("|---|---|---|---|---|---|---|---|");
  if (A === 0) {
    altDoc.push("| — | — | — | — | — | — | — | 今日无候补 |");
  } else {
    for (const { c } of alternates) {
      const total = c.score?.total ?? "—";
      const volFile = codeToVolFile.get(c.code) || "—";
      const kind = c.score?.kind || "corp";
      altDoc.push(
        `| ${c.code} | ${c.name} | ${rankLabel(c)}（${total}分） | ${industryGroupKey(c)} | ${c.price} | ${c.div}% | \`${kind}\` | [${volFile}](${volFile}) |`,
      );
    }
  }
  altDoc.push("");
  fs.writeFileSync(path.join(outDir, "01-候补名单.md"), altDoc.join("\n"), "utf8");

  // —— 分册 ——
  for (const vol of volumeRows) {
    const L = [];
    L.push(`# ${vol.title}（${vol.n} 只｜模板 \`${vol.kind}\`）`);
    L.push("");
    L.push(`← [${"00-总览.md"}](00-总览.md)｜生成时点 ${now.toISOString()}`);
    L.push("");
    L.push(
      "按东财 F10 三级行业分组（无 l3 则回退 f100）；组内按加权总分从高到低；行业按该组最高分降序。⚠️ 缺维票仍归原行业，不混排。每个 `### 行业` 块首附**近 N 月后复权回测**（评分名次 vs 收益名次；默认 36 月）。",
    );
    L.push("");
    L.push("| 行业 | 只数 | 组内第1 |");
    L.push("|---|---|---|");
    for (const [ind, list] of vol.industryGroups) {
      const top = list[0];
      L.push(`| ${ind} | ${list.length} | ${top.code} ${top.name} |`);
    }
    L.push("");
    for (const [ind, list] of vol.industryGroups) {
      L.push(`### ${ind}（${list.length} 只）`);
      L.push("");
      L.push(...renderIndustryBacktestBlock(industryBacktest.get(ind), { months: backtestMonths }));
      for (const c of list) {
        L.push(...renderStockCard(c, { bollCache, valCache, todayCodes }));
      }
    }
    fs.writeFileSync(path.join(outDir, vol.file), L.join("\n"), "utf8");
  }

  // —— 99 剔除 ——
  const rej = [];
  rej.push("# 硬门槛剔除简表");
  rej.push("");
  rej.push(`← [00-总览.md](00-总览.md)｜生成时点 ${now.toISOString()}`);
  rej.push("");
  rej.push("| 代码 | 简称 | 原因 |");
  rej.push("|---|---|---|");
  for (const r of step1.reject || []) {
    rej.push(`| ${r.code} | ${r.name} | ${(r.reject_reasons || []).join("；") || "股息缺失"} |`);
  }
  rej.push("");
  fs.writeFileSync(path.join(outDir, "99-硬筛剔除.md"), rej.join("\n"), "utf8");

  console.log(`REPORT_DIR=${outDir}`);
  console.log(`REPORT=${path.join(outDir, "00-总览.md")}`);
  console.log(`K=${K} A=${A}`);
  console.log(`VOLUMES=${volumeRows.map((v) => v.file).join(",")}`);
  return 0;
}

export {
  PRICE_SLACK,
  KIND_VOLUMES,
  bandRelFromMid,
  bollSignal,
  canBeAlternate,
  canSuggestToday,
  isAtOrWithinAbove,
  isAtOrWithinBelow,
  isMonthMidToLow,
  isPeerChampion,
  isWeekNearLow,
  main,
  pickIndustryWinners,
  pricePctFrom,
  valuationSnapshot,
  zoneLabel,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
