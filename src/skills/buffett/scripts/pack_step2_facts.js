#!/usr/bin/env node
/**
 * Step 2 事实卡：合并 Step1 pass + F10/分红包，并完成全量数字评分。
 * 红线定评、今日推荐、桌面终报仍由 Agent 写。
 *
 * 用法:
 *   node pack_step2_facts.js \
 *     --step1 ~/Desktop/temp/buffett_step1.json \
 *     --f10 ~/Desktop/temp/buffett_f10.json \
 *     --bond ~/Desktop/temp/buffett_bond.json \
 *     -o ~/Desktop/temp/buffett_step2_facts.md \
 *     --json ~/Desktop/temp/buffett_step2_facts.json
 */

import fs from "node:fs";
import { buffettTmp, parseArgs, readJsonFile } from "./opencli_json.js";
import { formatDimAnchor, formatScoreAnchorFooter } from "./anchor_display.js";
import { anchorProfile } from "./anchor_config.js";
import { collectRedFlags, fcfMagnitudeGap } from "./red_lines.js";
import { WEIGHTS, scoreCard } from "./score_numeric.js";

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function fmt(x, nd = 2) {
  if (x == null) return "—";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : x.toFixed(nd);
  return String(x);
}

function yiFromCap(cap) {
  const n = fnum(cap);
  if (n == null) return null;
  return n >= 1e6 ? n / 1e8 : n;
}

function entHint(controller, holder, orgForm) {
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

function industryRef(f100) {
  const profile = anchorProfile(f100);
  const m = profile.metrics;
  const pay = m.pay?.band ? `${m.pay.band[0]}%–${m.pay.band[1]}%` : "—";
  const debt = m.debt?.anchor == null ? "银行/保险通常不看负债率" : `约≤${m.debt.anchor}%`;
  const roe = m.roe?.anchor != null ? `约≥${m.roe.anchor}%` : "—";
  const pb = formatDimAnchor("pb", f100).replace(/（knot 线性插值）$/, "");
  return {
    f100: profile.industryKey || f100 || "—",
    text: `f100=${profile.industryKey || "无"}；派息 ${pay}；ROE 中枢 ${roe}；PB ${pb}；负债 ${debt}`,
  };
}

function fcfLines(rows) {
  if (!rows?.length) return ["（无）"];
  return rows.map((r) => {
    const bits = [
      `${r.year || "?"}年`,
      `OCF ${fmt(r.ocf, 0)}`,
      `资本开支 ${fmt(r.capex, 0)}`,
      `分红 ${fmt(r.div, 0)}${r.div_source ? `(${r.div_source})` : ""}`,
      r.fcf != null ? `FCF ${fmt(r.fcf, 0)}` : null,
      r.cover != null ? `覆盖 ${fmt(r.cover, 2)}` : null,
      r.profit != null ? `净利 ${fmt(r.profit, 0)}` : null,
      r.nco != null ? `净现比 ${fmt(r.nco, 2)}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  });
}

function specialLines(special) {
  if (!special?.kind) return ["（非银/未识别专项）"];
  const lines = [`kind=${special.kind} 来源 ${special.source || "—"}`];
  for (const y of special.years || []) {
    if (special.kind === "bank") {
      lines.push(
        `${y.year || "?"}：不良 ${fmt(y.npl)}% / 拨备 ${fmt(y.provision)}% / 核充 ${fmt(y.cet1)}% / 净息差 ${fmt(y.nim)}%`,
      );
    } else {
      lines.push(
        `${y.year || "?"}：偿付 ${fmt(y.solvency)}% / 投资收益 ${fmt(y.net_roi)}%`,
      );
    }
  }
  return lines;
}

function histText(summary, suffix = "%") {
  if (!summary?.n) return "—";
  const hist = (summary.history || []).map((row) => `${row.year || "?"}:${fmt(row.value)}${suffix}`).join(" / ");
  return `${hist}；${summary.n}年中位 ${fmt(summary.median)}${suffix}，波动σ ${fmt(summary.stdev)}${suffix}`;
}

function durabilityEvidenceLines(evidence, payHist) {
  const lines = [];
  if (evidence) {
    lines.push(`ROIC：${histText(evidence.roic_5y)}`);
    lines.push(`毛利率：${histText(evidence.gross_margin_5y)}`);
  }
  const dps = (payHist || [])
    .filter((row) => row.dps != null)
    .slice(0, 5)
    .map((row) => `${row.year}:${fmt(row.dps, 4)}`)
    .join(" / ");
  lines.push(`每股股息：${dps || "—"}`);
  return lines;
}

function buildCard(row, f10, bondY) {
  const f100 = row.f100 || f10.industry?.l2 || "";
  const ref = industryRef(f100);
  const q = f10.quote || {};
  const name = String(q.name || row.name || "").replace(/^(XD|XR|DR)/, "").replace(/ /g, "");
  const mktYi = fnum(row.mkt_yi) ?? yiFromCap(q.marketCap);
  const pb = fnum(q.priceBook) ?? fnum(row.pb);
  const price = fnum(q.price) ?? fnum(row.price);
  const covers = (f10.fcf_cov || []).map((x) => x.cover).filter((x) => x != null);
  const finKind =
    f10.special?.kind === "bank" || f10.special?.kind === "insurance"
      ? f10.special.kind
      : "corp";
  const mag = finKind === "corp" ? fcfMagnitudeGap(covers) : null;
  const flags = collectRedFlags({
    finKind,
    pay: fnum(f10.pay_ratio),
    div: row.div,
    fcfRows: f10.fcf_cov || [],
    latestProfit: f10.latest_profit ?? f10.fcf_cov?.[0]?.profit,
  });
  const redHints = flags.hard || [];
  const softHints = flags.soft || [];
  const gaps = [];
  if (f10.fetch_ok === false) gaps.push(`F10失败: ${f10.error || "unknown"}`);
  if (fnum(f10.pay_ratio) == null) gaps.push("派息率缺失");
  if (fnum(f10.roe3) == null) gaps.push("ROE3缺失");
  if (finKind === "corp" && !covers.length) gaps.push("FCF覆盖缺失");
  if (mag) gaps.push(mag);
  if ((f10.pay_fallback_reasons || []).some((x) => String(x).includes("sentinel"))) {
    gaps.push("派息率踩哨兵，先复核再打分");
  }

  return {
    code: String(row.code),
    name: name || row.name,
    market: row.market || f10.market,
    ent_hint: entHint(f10.controller, f10.holder, f10.org_form),
    controller: f10.controller || null,
    holder: f10.holder || null,
    org_form: f10.org_form || null,
    f100,
    f100_raw: row.f100_raw || f100,
    industry_f10: f10.industry || null,
    industry_ref: ref,
    price,
    pb,
    pe: fnum(q.peDynamic),
    mkt_yi: mktYi,
    div: fnum(row.div),
    bond_yield_pct: bondY,
    bond_ratio: fnum(row.bond_ratio),
    div_streak: row.div_streak,
    pay_ratio: fnum(f10.pay_ratio),
    pay_ratio_source: f10.pay_ratio_source || null,
    pay_ratio_year: f10.pay_ratio_year || null,
    pay_profile_pct: fnum(f10.pay_profile_pct),
    pay_calc_pct: fnum(f10.pay_calc_pct),
    pay_fallback_reasons: f10.pay_fallback_reasons || [],
    roe3: fnum(f10.roe3),
    roe_vals: f10.roe_vals || [],
    roe_hist: f10.roe_hist || [],
    pay_hist: f10.pay_hist || [],
    debt: fnum(f10.debt),
    fcf_cov: f10.fcf_cov || [],
    special: f10.special || null,
    durability_evidence: f10.durability_evidence || null,
    fin_kind: finKind,
    quote: q,
    fetch_ok: f10.fetch_ok !== false,
    red_hints: redHints,
    soft_hints: softHints,
    data_gaps: gaps,
  };
}

function previewTotal(score) {
  if (!score || score.total == null) return "⚠️";
  return `${score.total}${score.rating}`;
}

function dimOrder(kind) {
  return Object.keys(WEIGHTS[kind] || WEIGHTS.corp);
}

function dimValueText(d) {
  if (d.value == null) return "—";
  if (d.id === "roic_durability" || d.id === "margin_durability") {
    return `中位${fmt(d.value.median)}% / σ${fmt(d.value.stdev)}pct / n=${d.value.n ?? 0}`;
  }
  if (d.id === "dividend_discipline") {
    return `DPS下调${d.value.cuts ?? "—"}次 / 派息σ${fmt(d.value.payout_stdev)} / n=${d.value.years ?? 0}`;
  }
  if (d.id === "roe_stability") {
    return `中位${fmt(d.value.median)}% / CV${fmt(d.value.cv)} / n=${d.value.history?.length ?? 0}`;
  }
  if (typeof d.value === "object") {
    return Object.entries(d.value)
      .filter(([, value]) => typeof value !== "object")
      .map(([key, value]) => `${key}=${fmt(value)}`)
      .join(" ");
  }
  return fmt(d.value);
}

function renderScoreBlock(score) {
  if (!score) return ["- 数字维评分：无"];
  const L = [];
  L.push(
    `- 数字维同类组：\`${score.peer.key}\` n=${score.peer.n}${score.peer.n < 4 ? "（f100 不足 4 只，不用分位）" : ""}`,
  );
  if (score.anchors) {
    L.push(
      `- 评分锚版本：\`${score.anchors.version}\`；f100=${score.anchors.f100 || "无"}；PB=${score.anchors.pb_source}`,
    );
  }
  L.push("");
  L.push("| 维度 | 数值 | f100锚/标准值 | 分位 | 分位档 | 带宽 | 过热帽 | 脚本档 | 权重 |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const id of dimOrder(score.kind)) {
    const d = score.dims[id];
    if (!d) continue;
    const band = d.band ? `[${d.band.min},${d.band.max}] ${d.band.zone}` : "—";
    const cap = d.overheat?.cap != null ? String(d.overheat.cap) : "—";
    const val = dimValueText(d);
    const anchorText = formatDimAnchor(id, score.anchors?.f100);
    L.push(
      `| ${d.label} | ${val} | ${anchorText} | ${d.pct == null ? "—" : fmt(d.pct, 0)} | ${d.pct_bucket ?? "—"} | ${band} | ${cap} | ${d.usable ? d.score : "—"} | ${Math.round(d.weight * 100)}% |`,
    );
  }
  L.push(`| **合计** | — | ${formatScoreAnchorFooter(score)} | — | — | — | — | **${score.total ?? "—"}${score.rating ?? ""}** | 100% |`);
  L.push(`- 脚本总分（红线未核）：${score.total == null ? "⚠️" : `${score.total}${score.rating}`}`);
  if (!score.numeric_ok) {
    L.push(`- 数字维缺口：${score.missing.join("、")} → ⚠️ 暂停终评`);
  }
  for (const id of dimOrder(score.kind)) {
    const d = score.dims[id];
    if (!d?.reasons?.length) continue;
    L.push(`  - ${d.label}：${d.reasons.join("；")}`);
  }
  return L;
}

function renderMd(step1, bond, cards, paths) {
  const L = [];
  L.push(`# Buffett Step2 事实卡（数字维已评分）`);
  L.push("");
  L.push(
    "> 总分全部由脚本按「同类分位 + 宽带宽 + 自身历史 + 持久性」生成。经营壁垒仅作不计分备注；红线定评与今日推荐由 Agent 写。禁止重打维度或手算总分。",
  );
  L.push("");
  L.push("## 池摘要");
  L.push(`- N=${step1.n_pool} → 硬门槛过 M=${step1.n_pass}（剔除 ${step1.n_reject}）`);
  L.push(
    `- 国债：${bond.source || "—"} = **${fmt(bond.yield_pct)}%**（${bond.fetched_at || "—"}）`,
  );
  L.push(`- Step1：\`${paths.step1}\``);
  L.push(`- F10：\`${paths.f10}\``);
  L.push("");
  L.push("## 过门槛一览（全量数字评分）");
  L.push("");
  L.push("| 代码 | 简称 | f100 | 组(n) | 股息% | ROE3% | 脚本总分 | 缺口/红线提示 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const c of cards) {
    const warn =
      [
        ...(c.data_gaps || []),
        ...(c.red_hints || []).map((x) => `硬:${x}`),
        ...(c.soft_hints || []).map((x) => `软:${x}`),
      ].join("；") || "—";
    const pg = c.score?.peer;
    L.push(
      `| ${c.code} | ${c.name} | ${c.f100 || "—"} | ${pg ? `${pg.key} ${pg.n}` : "—"} | ${fmt(c.div)} | ${fmt(c.roe3)} | ${previewTotal(c.score)} | ${warn} |`,
    );
  }
  L.push("");
  L.push("## 硬门槛剔除");
  L.push("");
  L.push("| 代码 | 简称 | 原因 |");
  L.push("|---|---|---|");
  for (const r of step1.reject || []) {
    L.push(`| ${r.code} | ${r.name} | ${(r.reject_reasons || []).join(",")} |`);
  }
  L.push("");
  L.push("## 个股事实卡");
  L.push("");
  for (const c of cards) {
    L.push(`### ${c.code} ${c.name}`);
    L.push("");
    L.push(`- 行业：东财 f100 **${c.f100 || "—"}**${c.f100_raw && c.f100_raw !== c.f100 ? `（原始 ${c.f100_raw}）` : ""}`);
    L.push(`- 画像参考（非硬公式）：${c.industry_ref.text}`);
    L.push(
      `- 实控人：${c.controller || "—"}；控股：${c.holder || "—"}；脚本推断性质 **${c.ent_hint}**（以实控人为准，可推翻）`,
    );
    L.push(
      `- 行情：现价 ${fmt(c.price)}｜市值 ${fmt(c.mkt_yi)} 亿｜PB ${fmt(c.pb, 3)}｜PE ${fmt(c.pe)}｜TTM股息 ${fmt(c.div)}%｜股息/国债 ${fmt(c.bond_ratio)}x`,
    );
    L.push(
      `- 分红：连续 ${c.div_streak ?? "—"} 年｜派息 **${fmt(c.pay_ratio)}%**（${c.pay_ratio_source || "无来源"}${c.pay_ratio_year ? `，${c.pay_ratio_year}` : ""}）`,
    );
    L.push(
      `  - PROFILE ${fmt(c.pay_profile_pct)}%｜COMPRE自算 ${fmt(c.pay_calc_pct)}%｜备注 ${(c.pay_fallback_reasons || []).join(",") || "无"}`,
    );
    L.push(
      `- ROE3 均 ${fmt(c.roe3)}%（近3年 ${ (c.roe_vals || []).map((v) => fmt(v)).join(" / ") || "—" }；历史 ${(c.roe_hist || []).map((r) => `${r.year || "?"}:${fmt(r.roe)}`).join(" ") || "—"}）｜负债率 ${fmt(c.debt)}%`,
    );
    if ((c.pay_hist || []).length) {
      L.push(
        `- 派息历史：${c.pay_hist.map((r) => `${r.year}:派息${fmt(r.pay_pct)}%/DPS${fmt(r.dps, 4)}`).join(" / ")}`,
      );
    }
    L.push("- FCF/分红（金额多为东财原单位·元，打分前看量级哨兵）：");
    for (const line of fcfLines(c.fcf_cov)) L.push(`  - ${line}`);
    L.push("- 银行/保险专项：");
    for (const line of specialLines(c.special)) L.push(`  - ${line}`);
    L.push("- 持久性数据（直接进入脚本评分）：");
    for (const line of durabilityEvidenceLines(c.durability_evidence, c.pay_hist)) L.push(`  - ${line}`);
    L.push("- 经营壁垒备注：可选、不计分；仅记录已核实的牌照/资源/网络/转换成本/成本或品牌事实");
    L.push(`- 红线机械提示 hard（倾向一票否决，须复核）：${(c.red_hints || []).join("；") || "无"}`);
    L.push(
      `- 红线机械提示 soft（不自动否决）：${(c.soft_hints || []).join("；") || "无"}`,
    );
    L.push(`- 缺口：${(c.data_gaps || []).join("；") || "无"}`);
    L.push("");
    L.push("**全量数字评分**");
    L.push("");
    for (const line of renderScoreBlock(c.score)) L.push(line);
    L.push("");
  }
  L.push("生成时间：" + new Date().toISOString().replace(/\.\d{3}Z$/, ""));
  return L.join("\n") + "\n";
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.step1 || !args.f10 || !args.bond) {
    console.error(
      "usage: node pack_step2_facts.js --step1 PATH --f10 PATH --bond PATH [-o facts.md] [--json facts.json]",
    );
    return 1;
  }

  const step1 = readJsonFile(args.step1);
  const f10Rows = readJsonFile(args.f10);
  const bond = readJsonFile(args.bond);
  const f10By = Object.fromEntries(
    (Array.isArray(f10Rows) ? f10Rows : []).map((r) => [String(r.code), r]),
  );
  const bondY = Number(bond.yield_pct);

  const cards = (step1.pass || []).map((row) => {
    const f10 = f10By[String(row.code)] || { fetch_ok: false, code: row.code, error: "missing-f10" };
    return buildCard(row, f10, bondY);
  });
  for (const c of cards) c.score = scoreCard(c, cards);

  const paths = { step1: args.step1, f10: args.f10, bond: args.bond };
  const md = renderMd(step1, bond, cards, paths);
  const jsonPath = args.json;
  const outPath = args.output || buffettTmp("buffett_step2_facts.md");

  fs.writeFileSync(outPath, md, "utf8");
  if (jsonPath) {
    fs.writeFileSync(
      jsonPath,
      `${JSON.stringify({ bond, n_pass: cards.length, cards }, null, 2)}\n`,
      "utf8",
    );
  }
  console.log(`FACTS_MD=${outPath}`);
  if (jsonPath) console.log(`FACTS_JSON=${jsonPath}`);
  console.log(`M=${cards.length} gaps=${cards.filter((c) => c.data_gaps.length).length} scored=${cards.filter((c) => c.score).length}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
