#!/usr/bin/env node
/**
 * 桌面终报：读 Step2 事实卡 JSON，写 ~/Desktop/buffett-报告-YYYYMMDDHHmm.md
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
import { WEIGHTS } from "./score_numeric.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(x, nd = 2) {
  if (x == null) return "—";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : x.toFixed(nd);
  return String(x);
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

function zoneLabel(b) {
  if (!b?.ok) return b?.error || "无法计算";
  if (b.bandwidth_pct != null && b.bandwidth_pct < 5) return `带宽${b.bandwidth_pct}%（<5%观望）`;
  if (b.close <= b.lower) return "下轨附近";
  if (b.close >= b.upper) return "上轨附近";
  if (b.close <= b.mid) return "中～下轨";
  if (b.close > b.mid && b.close < b.upper) return "中～上轨（持有区）";
  return "中轨附近";
}

function bollSignal(bD, bW, bM, rating) {
  if (!bD?.ok || !bW?.ok || !bM?.ok) {
    return { signal: "K线不足，观望", batchOk: false };
  }
  if (bD.bandwidth_pct < 5) {
    return { signal: "日线带宽<5%，观望", batchOk: false };
  }
  const dayMidLow = bD.close >= bD.lower && bD.close <= bD.mid;
  const monthNearMid =
    Math.abs(bM.close - bM.mid) / bM.mid <= 0.05 ||
    (bM.close >= bM.lower && bM.close <= bM.mid * 1.05);
  const weekNearLow = bW.close <= bW.lower * 1.03;
  if (monthNearMid && dayMidLow) {
    return {
      signal: weekNearLow ? "可尝试批量建仓（周线共振）" : "可尝试批量建仓（周线未到下轨）",
      batchOk: rating === "🟢",
      weekResonance: weekNearLow,
    };
  }
  if (bM.close > bM.mid * 1.05) return { signal: "月线持有区，未到买点", batchOk: false };
  if (!dayMidLow) return { signal: "日线未到中～下轨", batchOk: false };
  if (!monthNearMid) return { signal: "月线未到中轨附近", batchOk: false };
  return { signal: "观望", batchOk: false };
}

function techBlock(card, boll) {
  const rating = card.score?.rating;
  const fmtB = (b, name) => {
    if (!b?.ok) return `${name}：${b?.error || "无法计算"}`;
    return `${name}：收盘(后复权)${b.close}｜中轨${b.mid}｜上${b.upper}｜下${b.lower}｜带宽${b.bandwidth_pct}%｜${zoneLabel(b)}`;
  };
  const sig = bollSignal(boll.D, boll.W, boll.M, rating);
  const near = boll.W?.mid;
  const opt =
    boll.W?.upper != null && boll.M?.upper != null
      ? Math.min(boll.W.upper, boll.M.upper)
      : boll.W?.upper ?? boll.M?.upper;
  return [
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
}

function actionBlock(card, sig) {
  const r = card.score?.rating;
  if (r === "🟢") {
    if (sig.batchOk && sig.weekResonance) return "今日可执行：批量建仓 ≤15%总资金。";
    if (sig.batchOk) return "可尝试批量建仓（周线未共振）≤15%总资金。";
    return "观望排队：质地够格但布林未到可尝试批量建仓条件。";
  }
  if (r === "🟡") return "🟡 不新建仓；仅用户已持仓可持有。";
  if (r === "🟠") return "观察；已持仓可持有；禁止新建仓。";
  if (r === "🔴") return "回避新建仓；已持仓建议复核减持/清仓。";
  return "数据缺口，暂停评级与操作。";
}

function crossCheck(card) {
  const bits = [];
  if (card.fin_kind === "bank") {
    bits.push(
      `银行分红看资产质量与核充；派息约 ${fmt(card.pay_ratio, 1)}%，分红纪律稳定与否须持续跟踪。`,
    );
  } else if (card.fin_kind === "insurance") {
    bits.push("保险看偿付与投资收益趋势。");
  } else {
    const cov = (card.fcf_cov || [])
      .slice(0, 2)
      .map((x) => `${x.year}覆盖${fmt(x.cover, 2)}`)
      .join("、");
    bits.push(cov ? `FCF分红覆盖：${cov}。` : "FCF覆盖待核。");
  }
  const r = card.score?.rating;
  bits.push(
    r === "🟢" || r === "🟡"
      ? "买点只认布林技术位，不用估值分位替代。"
      : "总分或红线未过关，不宜作为长线收息首选。",
  );
  return bits.join(" ");
}

function risks(card) {
  const rs = [];
  if (card.red_hints?.length) rs.push(`红线：${card.red_hints.join("；")}`);
  if (card.fin_kind === "bank") rs.push("净息差收窄与资产质量压力。");
  if (card.score?.missing?.length) rs.push(`数据缺口：${card.score.missing.join("、")}。`);
  if (rs.length < 2) rs.push(`${card.f100 || "行业"}竞争或政策变化可能削弱优势。`);
  if (rs.length < 3) rs.push("宏观利率上行压缩高股息相对吸引力。");
  return rs.slice(0, 3);
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
    "| 维度 | 数值 | f100锚/标准值 | 得分(0-100) | 权重 | 加权贡献 |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    L.push(`| ${r.label} | ${r.val} | ${r.anchor} | ${r.score} | ${r.w}% | ${r.contrib} |`);
  }
  L.push(`| **合计** | — | ${footer} | — | 100% | **${total}** |`);
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
  const rank = { "🟢": 0, "🟡": 1, "🟠": 2, "🔴": 3, "⚠️": 4 };
  cards.sort((a, b) => {
    const ra = rank[a.score?.rating] ?? 9;
    const rb = rank[b.score?.rating] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.score?.total || 0) - (a.score?.total || 0) || (b.bond_ratio || 0) - (a.bond_ratio || 0);
  });

  const bollCache = {};
  for (const c of cards) bollCache[c.code] = loadBoll(args.tmp, c.code);
  const gy = cards.filter((c) => c.score?.rating === "🟢" || c.score?.rating === "🟡");

  const todayBuys = [];
  const queue = [];
  for (const c of gy) {
    const boll = bollCache[c.code] || { D: null, W: null, M: null };
    const sig = bollSignal(boll.D, boll.W, boll.M, c.score.rating);
    if (c.score.rating === "🟢" && sig.batchOk) {
      todayBuys.push({ c, sig, boll });
    } else {
      let why = c.score.rating === "🟡" ? "🟡 不新建仓" : "未到可尝试批量建仓条件";
      if (sig.signal.includes("带宽")) why += "；日线带宽过窄";
      else if (sig.signal.includes("持有区")) why += "；月线持有区";
      else if (sig.signal.includes("日线")) why += "；日线未到中～下轨";
      else if (sig.signal.includes("月线")) why += "；月线未到中轨附近";
      else why += `；${sig.signal}`;
      queue.push(`${c.code} ${c.name}（${c.score.rating} ${c.score.total}分）：${why}`);
    }
  }

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
    `候选池：N=${step1.n_pool}（${xuangu.source || "xuangu-result-dom"}）→ 硬筛通过 M=${step1.n_pass} → 今日可执行 K=${K}`,
  );
  L.push("");
  L.push(`## 1. 今日推荐一览（K=${K}｜排队 Q=${queue.length}）`);
  L.push("");
  if (K === 0) {
    L.push("**今日无新开**：无 🟢 票满足「月线中轨附近 + 日线中～下轨」且各周期带宽≥5%。");
  }
  L.push("");
  L.push("| 代码 | 简称 | 评级 | 现价 | TTM股息率 | 信号来源 | 本次操作 | 建议仓位(总资金) | 目标价 |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  if (K === 0) {
    L.push("| — | — | — | — | — | — | 今日无新开 | — | — |");
  } else {
    for (const { c, boll } of todayBuys) {
      L.push(
        `| ${c.code} | ${c.name} | ${c.score.rating} | ${c.price} | ${c.div}% | 布林带 | 批量建仓 | ≤15% | 见§2 |`,
      );
    }
  }
  L.push("");
  L.push("**排队：**");
  L.push("");
  if (queue.length) for (const q of queue) L.push(`- ${q}`);
  else L.push("- （无 🟢/🟡 排队票）");
  L.push("");
  L.push(`## 2. 个股全评（全部 M=${cards.length} 只）`);
  L.push("");

  for (const c of cards) {
    const rating = c.score?.rating ?? "⚠️";
    const total = c.score?.total ?? "—";
    L.push(`#### ${c.code} ${c.name}（评级 ${rating}｜加权${total}分）`);
    L.push("");
    L.push(
      `**基础信息**：市值 ${c.mkt_yi} 亿；企业性质 ${c.ent_hint}；东财 f100=${c.f100}；现价 ${c.price}；${taxDiv(c.div)}；股息/国债比 ${fmt(c.bond_ratio, 2)}；连续现金分红 ${c.div_streak} 年。`,
    );
    L.push("");
    L.push("**评分表**（全部采用脚本结果）：");
    L.push("");
    L.push(scoreTable(c));
    L.push("");
    L.push(`**红线**：${redReview(c)}`);
    L.push(`**综合评级**：${rating}（脚本总分 ${total}）。`);
    L.push("");
    const boll = bollCache[c.code] || { D: null, W: null, M: null };
    const sig = bollSignal(boll.D, boll.W, boll.M, rating);
    L.push("**技术位**：");
    L.push(techBlock(c, boll));
    L.push("");
    L.push(`**预期目标价**：${boll.D?.ok ? "见技术位（操作采用技术档）" : "—"}`);
    L.push("");
    L.push(`**操作**：${actionBlock(c, sig)}`);
    L.push("");
    L.push(`**巴菲特交叉验证**：${crossCheck(c)}`);
    L.push("");
    L.push("**主要风险**：");
    risks(c).forEach((r, i) => L.push(`${i + 1}. ${r}`));
    L.push("");
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
  console.log(`K=${K} queue=${queue.length}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
