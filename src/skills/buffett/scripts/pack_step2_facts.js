#!/usr/bin/env node
/**
 * Step 2 事实卡：合并 Step1 pass + F10/分红包，并完成全量数字评分。
 * 红线机械提示写入 red_hints；今日名单由 gen_buffett_report.js 按全样本同业第1+布林筛选。
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
import { collectRedFlags, fcfMagnitudeGap } from "./red_lines.js";
import { WEIGHTS, assignPeerRanks, formatPeerRank, scoreCard } from "./score_numeric.js";
import { finKindFromF100, isCorpCashKind } from "./industry_map.js";

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

function industryRef(f100) {
  return {
    f100: f100 || "—",
    text: `f100=${f100 || "无"}；评分尺=硬筛通过池内同类分位；n=1 时自身历史≥3 年否则缺维`,
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
        `${y.year || "?"}：不良 ${fmt(y.npl)}% / 拨备 ${fmt(y.provision)}% / 核充 ${fmt(y.cet1)}% / 净息差 ${fmt(y.nim)}%` +
          (y.nonint_ratio != null ? ` / 非息 ${fmt(y.nonint_ratio)}%` : "") +
          (y.overdue_loans != null && y.npl_amt ? ` / 逾期/不良 ${fmt((y.overdue_loans / y.npl_amt) * 100, 1)}%` : ""),
      );
    } else if (special.kind === "insurance") {
      lines.push(
        `${y.year || "?"}：偿付 ${fmt(y.solvency)}%` +
          ` / 净投 ${fmt(y.net_roi)}%` +
          (y.total_roi != null ? ` / 总投 ${fmt(y.total_roi)}%` : "") +
          (y.nbv != null ? ` / NBV ${fmt(y.nbv / 1e8, 1)}亿` : "") +
          (y.nbv_rate != null ? ` / NBV率 ${fmt(y.nbv_rate)}%` : ""),
      );
    } else if (special.kind === "broker") {
      lines.push(
        `${y.year || "?"}：风险覆盖 ${fmt(y.risk_coverage)}%` +
          ` / 资本杠杆 ${fmt(y.capital_leverage)}%` +
          (y.pledge_cover != null ? ` / 质押保障 ${fmt(y.pledge_cover)}%` : "") +
          (y.fee_ratio != null ? ` / 手续费占营收 ${fmt(y.fee_ratio)}%` : "") +
          (y.interest_yoy != null ? ` / 利息同比 ${fmt(y.interest_yoy)}%` : "") +
          (y.invest_yoy != null ? ` / 投资同比 ${fmt(y.invest_yoy)}%` : ""),
      );
    } else if (special.kind === "utility") {
      lines.push(
        `${y.year || "?"}：利息保障 ${fmt(y.interest_cover)}x` +
          (y.ar_days != null ? ` / 应收周转天 ${fmt(y.ar_days)}` : "") +
          (y.rev_yoy != null ? ` / 营收同比 ${fmt(y.rev_yoy)}%` : "") +
          (y.profit_yoy != null ? ` / 净利同比 ${fmt(y.profit_yoy)}%` : ""),
      );
    } else if (special.kind === "resource_cycle") {
      lines.push(
        `${y.year || "?"}：利息保障 ${fmt(y.interest_cover)}x` +
          (y.interest_debt != null ? ` / 有息负债率 ${fmt(y.interest_debt)}%` : "") +
          (y.rev_yoy != null ? ` / 营收同比 ${fmt(y.rev_yoy)}%` : "") +
          (y.profit_yoy != null ? ` / 净利同比 ${fmt(y.profit_yoy)}%` : ""),
      );
    } else if (special.kind === "brand_consumer") {
      lines.push(
        `${y.year || "?"}：合同负债同比 ${fmt(y.contract_liab_yoy)}%` +
          (y.ar_days != null ? ` / 应收周转天 ${fmt(y.ar_days)}` : ""),
      );
    } else if (special.kind === "appliance" || special.kind === "tech_hardware") {
      lines.push(
        `${y.year || "?"}：合同负债同比 ${fmt(y.contract_liab_yoy)}%` +
          (y.ar_days != null ? ` / 应收天 ${fmt(y.ar_days)}` : "") +
          (y.inv_days != null ? ` / 存货天 ${fmt(y.inv_days)}` : ""),
      );
    } else if (special.kind === "equip_mfg") {
      lines.push(
        `${y.year || "?"}：利息保障 ${fmt(y.interest_cover)}x` +
          (y.ar_days != null ? ` / 应收天 ${fmt(y.ar_days)}` : "") +
          (y.contract_liab_yoy != null ? ` / 合同负债同比 ${fmt(y.contract_liab_yoy)}%` : ""),
      );
    } else if (special.kind === "infra_construction") {
      lines.push(
        `${y.year || "?"}：利息保障 ${fmt(y.interest_cover)}x` +
          (y.ar_days != null ? ` / 应收天 ${fmt(y.ar_days)}` : "") +
          (y.contract_asset_yoy != null ? ` / 合同资产同比 ${fmt(y.contract_asset_yoy)}%` : "") +
          (y.ar_yoy != null ? ` / 应收同比 ${fmt(y.ar_yoy)}%` : ""),
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
  const finKind = finKindFromF100(f100);
  const mag =
    isCorpCashKind(finKind) &&
    finKind !== "utility" &&
    finKind !== "resource_cycle" &&
    finKind !== "brand_consumer" &&
    finKind !== "infra_construction" &&
    finKind !== "appliance" &&
    finKind !== "equip_mfg" &&
    finKind !== "tech_hardware" &&
    finKind !== "corp"
      ? fcfMagnitudeGap(covers)
      : null;
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
  if (isCorpCashKind(finKind) && !covers.length) gaps.push("FCF覆盖缺失");
  if (mag) gaps.push(mag);
  if ((f10.pay_fallback_reasons || []).some((x) => String(x).includes("sentinel"))) {
    gaps.push("派息率踩哨兵，先复核再打分");
  }

  return {
    code: String(row.code),
    name: name || row.name,
    market: row.market || f10.market,
    controller: f10.controller || null,
    holder: f10.holder || null,
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
    special: {
      ...(f10.special || {}),
      kind:
        finKind === "bank" ||
        finKind === "insurance" ||
        finKind === "broker" ||
        finKind === "utility" ||
        finKind === "resource_cycle" ||
        finKind === "brand_consumer" ||
        finKind === "infra_construction" ||
        finKind === "appliance" ||
        finKind === "equip_mfg" ||
        finKind === "tech_hardware"
          ? finKind
          : f10.special?.kind || null,
    },
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
  const rank = formatPeerRank(score);
  return rank === "—" ? String(score.total) : `${rank}｜${score.total}`;
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
    `- 数字维同类组：\`${score.peer.key}\` n=${score.peer.n}${score.peer.n < 2 ? "（n<2 → 自身历史分位；历史<3年则缺维⚠️）" : ""}`,
  );
  if (score.anchors) {
    L.push(
      `- 评分尺：\`${score.anchors.version}\`；f100=${score.anchors.f100 || "无"}；PB=${score.anchors.pb_source}`,
    );
  }
  L.push("");
  L.push("| 维度 | 数值 | 对照说明 | 分位 | 脚本档 | 权重 |");
  L.push("|---|---|---|---|---|---|");
  for (const id of dimOrder(score.kind)) {
    const d = score.dims[id];
    if (!d) continue;
    const val = dimValueText(d);
    const anchorText = formatDimAnchor(id, score.anchors?.f100);
    L.push(
      `| ${d.label} | ${val} | ${anchorText} | ${d.pct == null ? "—" : fmt(d.pct, 0)} | ${d.usable ? d.score : "—"} | ${Math.round(d.weight * 100)}% |`,
    );
  }
  L.push(`| **合计** | — | ${formatScoreAnchorFooter(score)} | — | **${score.total ?? "—"}${score.rating ? `｜${score.rating}` : ""}** | 100% |`);
  L.push(`- 脚本总分（红线未核）：${score.total == null ? "⚠️" : `${formatPeerRank(score)}｜${score.total}`}`);
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
    "> 总分全部由脚本按「同类（同一 f100）分位」生成。knot/过热帽仅对照不进得分。经营壁垒仅作不计分备注；hard 红线排除今日建议。禁止重打维度或手算总分。",
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
  L.push("| 代码 | 简称 | f100 | 组(n) | 股息% | ROE3% | 排名｜总分 | 缺口/红线提示 |");
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
    L.push(`- 实控人：${c.controller || "—"}；控股：${c.holder || "—"}`);
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
  assignPeerRanks(cards);

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
