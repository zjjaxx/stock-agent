#!/usr/bin/env node
/**
 * 桌面终报骨架：读 Step2 事实卡 JSON，写 ~/Desktop/buffett-报告-YYYYMMDDHHmm.md
 *
 * 脚本只输出：§1 一览（全样本同业第1且布林到位、无 hard 红线）、§2 按 f100 分类/组内分数降序的数字技术操作骨架、§3 硬筛剔除。
 * 「巴菲特交叉验证」「主要风险」留空位，由 Agent 按 Buffett 视角逐票现写。
 *
 * 用法:
 *   node gen_buffett_report.js
 *   node gen_buffett_report.js --facts ~/Desktop/temp/buffett_step2_facts.json --step1 ~/Desktop/temp/buffett_step1.json
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatDimAnchor, formatScoreAnchorFooter } from "./anchor_display.js";
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
        anchor: formatDimAnchor(d.id, card.f100),
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

function loadBoll(tmpDir, code) {
  const result = { D: null, W: null, M: null };
  for (const [p, key] of [
    ["day", "D"],
    ["week", "W"],
    ["month", "M"],
  ]) {
    const klinePath = path.join(tmpDir, `${code}_${p}.json`);
    if (!fs.existsSync(klinePath)) continue;
    try {
      const out = execFileSync("node", [path.join(HERE, "calc_bollinger.js"), klinePath], {
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      result[key] = parsed.bands?.[key] || null;
    } catch {
      const bollPath = path.join(tmpDir, `${code}_${p}_boll.json`);
      if (fs.existsSync(bollPath)) {
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

/** 仅由周/月布林技术位判定：周下 + 月中～月下（边界一律股价 5%）。日线不进建仓门槛。 */
function bollSignal(bD, bW, bM) {
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

function techBlock(boll) {
  const fmtB = (b, name) => {
    if (!b?.ok) return `${name}：${b?.error || "无法计算"}`;
    return `${name}：收盘(后复权)${b.close}｜中轨${b.mid}｜上${b.upper}｜下${b.lower}｜带宽${b.bandwidth_pct}%｜${zoneLabel(b)}`;
  };
  const sig = bollSignal(boll.D, boll.W, boll.M);
  const near = boll.W?.mid;
  const opt =
    boll.W?.upper != null && boll.M?.upper != null
      ? Math.min(boll.W.upper, boll.M.upper)
      : boll.W?.upper ?? boll.M?.upper;
  const text = [
    fmtB(boll.D, "日线"),
    fmtB(boll.W, "周线"),
    fmtB(boll.M, "月线"),
    `信号来源：布林带｜结论：${sig.signal}`,
    `K 线来源：后复权 fetch_kline_hfq.js fqt=2，as_of=${boll.D?.as_of || "—"}`,
    near != null
      ? `技术目标（后复权轨）：近端=周中轨 ${near}；乐观=周/月上轨更保守者 ${fmt(opt)}`
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

function f100Key(card) {
  return (
    String(card.f100 || "")
      .replace(/[ⅠⅡⅢIVX\s]/g, "")
      .trim() || "未知行业"
  );
}

function isScoreGap(card) {
  return !card.score?.numeric_ok || card.score?.total == null;
}

/** 全样本（硬筛池 M）内同 f100 加权总分第 1（并列共享名次亦算）。 */
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

function pickIndustryWinners(rows) {
  const byInd = new Map();
  for (const row of rows) {
    const key = f100Key(row.c);
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
    return "建仓建议（全样本同业第1 + 布林到位：周下+月中～下）";
  }
  if (sig.batchOk && hasHardRed(card)) {
    return `观望：布林到位，hard红线不入今日建议：${card.red_hints.join("；")}。`;
  }
  if (sig.batchOk && isScoreGap(card)) {
    return "观望：布林到位，数据缺口不入今日建议。";
  }
  if (sig.batchOk && !isPeerChampion(card)) {
    return "观望：布林到位，但非全样本同业第1（冠军未到买点或分数更高）。";
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

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      step1: buffettTmp("buffett_step1.json"),
      xuangu: buffettTmp("buffett_xuangu_result.json"),
      tmp: buffettTmpDir(),
    },
  });

  const data = readJsonFile(args.facts);
  const step1 = readJsonFile(args.step1);
  const xuangu = fs.existsSync(args.xuangu) ? readJsonFile(args.xuangu) : { source: "—" };
  const cards = [...(data.cards || [])];
  assignPeerRanks(cards);

  const bollCache = {};
  const sigCache = {};
  for (const c of cards) {
    const boll = loadBoll(args.tmp, c.code);
    bollCache[c.code] = boll;
    sigCache[c.code] = bollSignal(boll.D, boll.W, boll.M);
  }

  const eligible = cards
    .filter((c) => canSuggestToday(c, sigCache[c.code]))
    .map((c) => ({ c, sig: sigCache[c.code], boll: bollCache[c.code] }));
  const industryWinners = pickIndustryWinners(eligible);
  const todayBuys = [...industryWinners].sort(rankTodayWinners);

  const todayCodes = new Set(todayBuys.map(({ c }) => c.code));

  /** §2：按东财 f100 分组；组内按加权总分从高到低；行业按组内最高分降序。 */
  function scoreDesc(a, b) {
    return (
      (b.score?.total ?? -1) - (a.score?.total ?? -1) ||
      (b.bond_ratio || 0) - (a.bond_ratio || 0) ||
      String(a.code).localeCompare(String(b.code))
    );
  }
  const byIndustry = new Map();
  for (const c of cards) {
    const key = f100Key(c);
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key).push(c);
  }
  for (const list of byIndustry.values()) list.sort(scoreDesc);
  const industryGroups = [...byIndustry.entries()].sort((a, b) => {
    const maxA = a[1][0]?.score?.total ?? -1;
    const maxB = b[1][0]?.score?.total ?? -1;
    return maxB - maxA || a[0].localeCompare(b[0], "zh");
  });

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const outPath = args.output || path.join(process.env.HOME, "Desktop", `buffett-报告-${stamp}.md`);
  const K = todayBuys.length;

  const L = [];
  L.push("# A股高股息长线复利 · 今日报告");
  L.push("");
  L.push(`生成时点：${now.toISOString()}｜研究框架，不构成投资建议。`);
  L.push(
    `国债10Y：${data.bond.yield_pct}%（${data.bond.source}，${data.bond.fetched_at}）｜股息门槛：≥国债×2 = ${(data.bond.yield_pct * 2).toFixed(2)}%`,
  );
  L.push(
    `候选池：N=${step1.n_pool}（${xuangu.source || "xuangu-result-dom"}）→ 硬筛通过 M=${step1.n_pass} → 今日建仓建议 K=${K}`,
  );
  L.push("");
  L.push(`## 1. 今日建仓建议一览（K=${K}）`);
  L.push("");
  L.push("本次操作为「全样本同业第1（硬筛池 M 内同 f100 总分第1，并列共享）+ 布林到位 + 无 hard 红线/⚠️」——宁缺毋滥，允许 K=0。跨行业不比总分。");
  L.push("");
  if (K === 0) {
    L.push("**今日无建仓建议**：无票同时满足「全样本同业第1 + 周线下轨附近 + 月线中～下轨（边界均≤股价5%）+ 无 hard 红线」。");
    L.push("");
  }
  L.push("| 代码 | 简称 | 行业排名 | 现价 | TTM股息率 | 信号来源 | 本次操作 | 目标价 |");
  L.push("|---|---|---|---|---|---|---|---|");
  if (K === 0) {
    L.push("| — | — | — | — | — | — | 今日无建仓建议 | — |");
  } else {
    for (const { c } of todayBuys) {
      const total = c.score?.total ?? "—";
      L.push(
        `| ${c.code} | ${c.name} | ${rankLabel(c)}（${total}分） | ${c.price} | ${c.div}% | 布林带 | 建仓建议（全样本同业第1+布林） | 见§2 |`,
      );
    }
  }
  L.push("");
  L.push(`## 2. 个股全评（全部 M=${cards.length} 只｜按 f100 分类，组内分数降序）`);
  L.push("");

  for (const [ind, list] of industryGroups) {
    L.push(`### ${ind}（${list.length} 只）`);
    L.push("");
    for (const c of list) {
      const rank = rankLabel(c);
      const total = c.score?.total ?? "—";
      L.push(`#### ${c.code} ${c.name}（${rank}｜加权${total}分）`);
      L.push("");
      L.push(
        `**基础信息**：市值 ${fmtYi(c.mkt_yi)} 亿；东财 f100=${c.f100}；现价 ${c.price}；${taxDiv(c.div)}；股息/国债比 ${fmt(c.bond_ratio, 2)}；连续现金分红 ${c.div_streak} 年。`,
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
      const { text: techText, sig } = techBlock(boll);
      L.push("**技术位**：");
      L.push(techText);
      L.push("");
      L.push(`**预期目标价**：${boll.D?.ok ? "见技术位（操作采用技术档）" : "—"}`);
      L.push("");
      L.push(
        `**操作**：${actionBlock(c, sig, { inToday: todayCodes.has(c.code) })}`,
      );
      L.push("");
      L.push("**巴菲特交叉验证**：（Agent 按 Buffett 视角现写，2–4 句）");
      L.push("");
      L.push("**主要风险**：（Agent 现写 1–3 条，须对本票特异）");
      L.push("");
    }
  }

  L.push("## 3. 硬门槛剔除简表");
  L.push("");
  L.push("| 代码 | 简称 | 原因 |");
  L.push("|---|---|---|");
  for (const r of step1.reject || []) {
    L.push(`| ${r.code} | ${r.name} | ${(r.reject_reasons || []).join("；") || "连续分红不足"} |`);
  }
  L.push("");

  fs.writeFileSync(outPath, L.join("\n"), "utf8");
  console.log(`REPORT=${outPath}`);
  console.log(`K=${K}`);
  return 0;
}

export {
  PRICE_SLACK,
  bandRelFromMid,
  bollSignal,
  canSuggestToday,
  isAtOrWithinAbove,
  isAtOrWithinBelow,
  isMonthMidToLow,
  isPeerChampion,
  isWeekNearLow,
  main,
  pickIndustryWinners,
  pricePctFrom,
  zoneLabel,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
