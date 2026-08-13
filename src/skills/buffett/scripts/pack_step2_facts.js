#!/usr/bin/env node
/**
 * Step 2 事实卡：合并 Step1 pass + F10/分红包，供 Agent 打分。
 * 不计算六维得分、不给 🟢/🟡、不写桌面终报。
 *
 * 用法:
 *   node pack_step2_facts.js \
 *     --step1 /tmp/buffett_step1.json \
 *     --f10 /tmp/buffett_f10.json \
 *     --bond /tmp/buffett_bond.json \
 *     -o /tmp/buffett_step2_facts.md \
 *     --json /tmp/buffett_step2_facts.json
 */

import fs from "node:fs";
import { parseArgs, readJsonFile } from "./opencli_json.js";
import { CLASS_META } from "./industry_map.js";
import { collectRedFlags, fcfMagnitudeGap } from "./red_lines.js";

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

function industryRef(cls) {
  const m = CLASS_META[cls] || CLASS_META.G;
  const pay = m.pay ? `${m.pay[0]}%–${m.pay[1]}%` : "—";
  const debt = m.debt == null ? "银行/保险不看负债率" : `约≤${m.debt}%`;
  return {
    cls,
    name: m.name,
    pay_band: pay,
    roe_anchor: `约≥${m.roe}%`,
    pb_soft: `约≤${m.pb}`,
    debt_note: debt,
    text:
      `派息常见 ${pay}；ROE 中枢 ${`约≥${m.roe}%`}；PB 软参考 约≤${m.pb}；负债 ${debt}`,
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

function buildCard(row, f10, bondY) {
  const cls = row.ind_class || "G";
  const ref = industryRef(cls);
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
  const redHints = collectRedFlags({
    finKind,
    pay: fnum(f10.pay_ratio),
    div: row.div,
    fcfRows: f10.fcf_cov || [],
    latestProfit: f10.latest_profit ?? f10.fcf_cov?.[0]?.profit,
  });
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
    ind_class: cls,
    ind_name: row.ind_name || ref.name,
    f100: row.f100 || f10.industry?.l2 || "",
    industry_f10: f10.industry || null,
    industry_ref: ref,
    cycle_caution: Boolean(row.cycle_caution),
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
    debt: fnum(f10.debt),
    fcf_cov: f10.fcf_cov || [],
    special: f10.special || null,
    quote: q,
    fetch_ok: f10.fetch_ok !== false,
    red_hints: redHints,
    data_gaps: gaps,
  };
}

function renderMd(step1, bond, cards, paths) {
  const L = [];
  L.push(`# Buffett Step2 事实卡（供 Agent 打分）`);
  L.push("");
  L.push("> 本文件**没有**六维得分或今日推荐。脚本只摊数据；评分按 SKILL Step 2 由 Agent 完成。");
  L.push("");
  L.push("## 池摘要");
  L.push(`- N=${step1.n_pool} → 硬门槛过 M=${step1.n_pass}（剔除 ${step1.n_reject}）`);
  L.push(
    `- 国债：${bond.source || "—"} = **${fmt(bond.yield_pct)}%**（${bond.fetched_at || "—"}）`,
  );
  L.push(`- Step1：\`${paths.step1}\``);
  L.push(`- F10：\`${paths.f10}\``);
  L.push("");
  L.push("## 过门槛一览（无评分）");
  L.push("");
  L.push("| 代码 | 简称 | 行业类 | 股息% | 派息% | ROE3% | PB | 连续分红 | 缺口/红线提示 |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of cards) {
    const warn = [...(c.data_gaps || []), ...(c.red_hints || [])].join("；") || "—";
    L.push(
      `| ${c.code} | ${c.name} | ${c.ind_class}/${c.ind_name} | ${fmt(c.div)} | ${fmt(c.pay_ratio)} | ${fmt(c.roe3)} | ${fmt(c.pb, 2)} | ${c.div_streak ?? "—"} | ${warn} |`,
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
    L.push(
      `- 行业：东财 ${c.f100 || "—"} → **${c.ind_class} ${c.ind_name}**${c.cycle_caution ? "（周期谨慎）" : ""}`,
    );
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
    L.push(`- ROE3 均 ${fmt(c.roe3)}%（各年 ${ (c.roe_vals || []).map((v) => fmt(v)).join(" / ") || "—" }）｜负债率 ${fmt(c.debt)}%`);
    L.push("- FCF/分红（金额多为东财原单位·元，打分前看量级哨兵）：");
    for (const line of fcfLines(c.fcf_cov)) L.push(`  - ${line}`);
    L.push("- 银行/保险专项：");
    for (const line of specialLines(c.special)) L.push(`  - ${line}`);
    L.push(`- 红线机械提示（供复核，不自动定评）：${(c.red_hints || []).join("；") || "无"}`);
    L.push(`- 缺口：${(c.data_gaps || []).join("；") || "无"}`);
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

  const paths = { step1: args.step1, f10: args.f10, bond: args.bond };
  const md = renderMd(step1, bond, cards, paths);
  const jsonPath = args.json;
  const outPath = args.output || "/tmp/buffett_step2_facts.md";

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
  console.log(`M=${cards.length} gaps=${cards.filter((c) => c.data_gaps.length).length}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
