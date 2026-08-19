#!/usr/bin/env node
/**
 * 十年锚校准：抓 ROE/ROIC/负债/毛利率/派息率历史，先算公司长期中位，
 * 再算行业“公司中位的中位”，生成 candidate JSON 和人工复核报告。
 *
 * PB 明确不在本阶段抓取或校准。
 *
 * 用法:
 *   node calibrate_anchors.js --pool ~/Desktop/temp/buffett_anchor_pool.json --resume
 *   node calibrate_anchors.js --raw PATH --candidate PATH --report PATH
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserFetchJson,
  datacenterRows,
  datacenterUrl,
  parseArgs,
  readJsonFile,
  secucode,
} from "./opencli_json.js";
import {
  APPROVED_ANCHORS,
  APPROVED_ANCHOR_PATH,
  isFinancialF100,
  usesCorpCashMetrics,
  normalizeIndustry,
} from "./anchor_config.js";

const SCHEMA_VERSION = 2;
const METRIC_LABELS = {
  roe: "ROE中位(%)",
  roic: "ROIC中位(%)",
  debt: "资产负债率中位(%)",
  pay: "派息率健康区间(%)",
  margin_sigma: "毛利率标准差阈值",
  roe_cv: "ROE变异系数阈值",
};

function fnum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  return quantile(values, 0.5);
}

function quantile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

function stdev(values) {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return null;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - avg) ** 2, 0) / xs.length);
}

function cv(values) {
  const med = median(values);
  const sigma = stdev(values);
  if (med == null || sigma == null || Math.abs(med) < 1) return null;
  return sigma / Math.abs(med);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function yearOf(row, key = "REPORT_DATE") {
  return String(row?.[key] || "").match(/(20\d{2})/)?.[1] || null;
}

function annualRows(rows) {
  return (rows || []).filter((row) => {
    const date = String(row.REPORT_DATE || "");
    return (
      date.includes("-12-31") ||
      date.endsWith("12-31") ||
      String(row.REPORT_TYPE || "").includes("年报")
    );
  });
}

function fetchReport(session, report, sc, opts = {}) {
  const payload = browserFetchJson(session, datacenterUrl(report, sc, opts), { sleepS: 0.35 });
  return datacenterRows(payload);
}

function compactHistory(poolItem, lookback, session) {
  const sc = secucode(poolItem.code, poolItem.market);
  const dup = annualRows(
    fetchReport(session, "RPT_F10_FINANCE_DUPONT", sc, {
      pageSize: 48,
      sortColumns: "REPORT_DATE",
    }),
  );
  const fina = annualRows(
    fetchReport(session, "RPT_F10_FINANCE_MAINFINADATA", sc, {
      pageSize: 48,
      sortColumns: "REPORT_DATE",
    }),
  );
  const compre = fetchReport(session, "RPT_F10_DIVIDEND_COMPRE", sc, {
    pageSize: 24,
    sortColumns: "STATISTICS_YEAR",
  });

  const byYear = {};
  function ensure(year) {
    if (!year) return null;
    if (!byYear[year]) byYear[year] = { year };
    return byYear[year];
  }
  for (const row of dup) {
    const out = ensure(yearOf(row));
    if (!out) continue;
    if (out.roe == null) out.roe = fnum(row.ROE ?? row.ROEJQ);
    if (out.debt == null) out.debt = fnum(row.DEBT_ASSET_RATIO);
    if (out.parent_netprofit == null) out.parent_netprofit = fnum(row.PARENT_NETPROFIT);
  }
  for (const row of fina) {
    const out = ensure(yearOf(row));
    if (!out) continue;
    if (out.roe == null) out.roe = fnum(row.ROEJQ ?? row.ROE);
    if (out.roic == null) out.roic = fnum(row.ROIC);
    if (out.gross_margin == null) out.gross_margin = fnum(row.XSMLL);
  }
  for (const row of compre) {
    const year = String(row.STATISTICS_YEAR || "").match(/(20\d{2})/)?.[1];
    const out = ensure(year);
    const dividend = fnum(row.TOTAL_DIVIDEND);
    if (!out || out.pay != null || dividend == null || !(out.parent_netprofit > 0)) continue;
    const pay = (dividend / out.parent_netprofit) * 100;
    out.pay = pay > 0 && pay <= 150 ? round(pay) : null;
  }

  const latestYear = new Date().getFullYear() - 1;
  const cutoff = latestYear - Number(lookback) + 1;
  return Object.values(byYear)
    .filter((row) => Number(row.year) >= cutoff && Number(row.year) <= latestYear)
    .sort((a, b) => Number(b.year) - Number(a.year))
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)));
}

function companyFeatures(row) {
  const history = row.history || [];
  const values = (key) => history.map((x) => fnum(x[key])).filter((x) => x != null);
  const roe = values("roe");
  const roic = values("roic");
  const debt = values("debt");
  const pay = values("pay");
  const margin = values("gross_margin");
  const corpCash = usesCorpCashMetrics(row.f100);
  const skipDebt = isFinancialF100(row.f100);
  return {
    roe: roe.length >= 5 ? median(roe) : null,
    roe_cv: roe.length >= 5 ? cv(roe) : null,
    roic: corpCash && roic.length >= 5 ? median(roic) : null,
    roic_cv: corpCash && roic.length >= 5 ? cv(roic) : null,
    debt: !skipDebt && debt.length >= 5 ? median(debt) : null,
    pay: pay.length >= 5 ? median(pay) : null,
    margin_sigma: corpCash && margin.length >= 5 ? stdev(margin) : null,
    coverage: {
      roe: roe.length,
      roic: roic.length,
      debt: debt.length,
      pay: pay.length,
      gross_margin: margin.length,
    },
  };
}

function metricProposal(rows, metric, minCompanies) {
  const values = rows.map((row) => fnum(row.features?.[metric])).filter((x) => x != null);
  const n = values.length;
  if (n < minCompanies) return { n, calibrated: false };
  if (metric === "pay") {
    return { n, calibrated: true, band: [round(quantile(values, 0.2)), round(quantile(values, 0.8))] };
  }
  if (metric === "roic_cv") {
    return {
      n,
      calibrated: true,
      cv_cuts: [0.5, 0.75, 0.9].map((p) => round(quantile(values, p), 3)),
    };
  }
  if (metric === "margin_sigma" || metric === "roe_cv") {
    return {
      n,
      calibrated: true,
      cuts: [0.25, 0.5, 0.75, 0.9].map((p) => round(quantile(values, p), 3)),
    };
  }
  return { n, calibrated: true, anchor: round(median(values)) };
}

function calibratedMetrics(rows, minCompanies) {
  const out = {};
  for (const metric of Object.keys(METRIC_LABELS)) {
    const proposal = metricProposal(rows, metric, minCompanies);
    if (metric === "roic") {
      const cvProposal = metricProposal(rows, "roic_cv", minCompanies);
      if (!proposal.calibrated && !cvProposal.calibrated) continue;
      out.roic = {
        ...(proposal.calibrated ? { anchor: proposal.anchor, n: proposal.n } : {}),
        ...(cvProposal.calibrated ? { cv_cuts: cvProposal.cv_cuts, cv_n: cvProposal.n } : {}),
        calibration_status: "calibrated",
      };
      continue;
    }
    if (proposal.calibrated) {
      delete proposal.calibrated;
      out[metric] = { ...proposal, calibration_status: "calibrated" };
    }
  }
  return out;
}

export function buildCandidate(rawRows, { minCompanies = 2, lookbackYears = 10 } = {}) {
  const usable = rawRows.filter((row) => row.fetch_ok).map((row) => ({
    ...row,
    features: companyFeatures(row),
  }));

  const industries = {};
  const names = [...new Set(usable.map((row) => normalizeIndustry(row.f100)).filter(Boolean))];
  for (const name of names.sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    const rows = usable.filter((row) => normalizeIndustry(row.f100) === name);
    const metrics = calibratedMetrics(rows, minCompanies);
    if (!Object.keys(metrics).length) continue;
    industries[name] = {
      n: rows.length,
      confidence: rows.length >= minCompanies ? "calibrated" : "insufficient",
      metrics,
    };
  }
  return {
    schema_version: 2,
    status: "candidate",
    version: `candidate-${new Date().toISOString().slice(0, 10)}`,
    generated_at: new Date().toISOString(),
    source_approved_version: APPROVED_ANCHORS.version,
    lookback_years: lookbackYears,
    method: "median_of_company_medians",
    min_companies: minCompanies,
    pb_calibration_enabled: false,
    industries,
  };
}

function valueText(metric) {
  if (!metric) return "—";
  const value = metric.anchor ?? metric.band ?? metric.cv_cuts ?? metric.cuts;
  return Array.isArray(value) ? value.join(" / ") : String(value ?? "—");
}

function reportMarkdown(candidate, rawRows) {
  const lines = [
    `# Buffett 锚校准候选报告（${candidate.generated_at.slice(0, 10)}）`,
    "",
    `- 样本：${rawRows.filter((x) => x.fetch_ok).length}/${rawRows.length} 抓取成功`,
    `- 窗口：近 ${candidate.lookback_years} 个完整财年`,
    `- 方法：先取每家公司长期中位，再取行业横截面中位；至少 ${candidate.min_companies} 家才替换`,
    "- PB：本阶段明确不抓取、不校准；有 f100 PB 锚则用，否则 PB 维仅同类分位",
    "- 候选文件不会自动生效，必须用 approve_anchors.js 审批",
    "",
    "## f100 行业候选",
    "",
    "| 行业 | 指标 | 现行值 | 候选值 | N | 处理 |",
    "|---|---|---:|---:|---:|---|",
  ];
  for (const [name, node] of Object.entries(candidate.industries)) {
    for (const [metric, value] of Object.entries(node.metrics || {})) {
      const current = APPROVED_ANCHORS.industries?.[name]?.metrics?.[metric];
      lines.push(
        `| ${name} | ${METRIC_LABELS[metric]} | ${valueText(current)} | ${valueText(value)} | ${value.n ?? node.n ?? "—"} | ${value.calibration_status} |`,
      );
    }
  }
  lines.push("");
  for (const [name, node] of Object.entries(candidate.industries)) {
    lines.push(`### ${name}（样本 ${node.n} 家，${node.confidence}）`, "");
    for (const [metric, value] of Object.entries(node.metrics || {})) {
      lines.push(`- ${METRIC_LABELS[metric]}：${valueText(value)}（N=${value.n}）`);
    }
    lines.push("");
  }
  const failed = rawRows.filter((row) => !row.fetch_ok);
  if (failed.length) {
    lines.push("## 抓取失败", "");
    for (const row of failed) lines.push(`- ${row.code} ${row.name}: ${row.error}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function loadPool(file) {
  const data = readJsonFile(file);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.pool)) return data.pool;
  throw new Error("pool 须为数组或包含 pool 数组");
}

function main() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const temp = path.join(os.homedir(), "Desktop", "temp");
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      session: "buffett-anchor-calibration",
      raw: path.join(temp, "buffett_anchor_history.json"),
      candidate: path.join(temp, `buffett_anchors_candidate_${date}.json`),
      report: path.join(os.homedir(), "Desktop", `buffett-anchor-report-${date}.md`),
      lookback: "10",
      "min-companies": "2",
    },
    booleans: ["resume"],
  });
  const lookbackYears = Number(args.lookback);
  const minCompanies = Number(args.minCompanies);
  let rawRows = [];
  if (args.resume && fs.existsSync(args.raw)) {
    const existing = readJsonFile(args.raw);
    rawRows = Array.isArray(existing) ? existing : existing.rows || [];
  }
  const byCode = new Map(rawRows.map((row) => [String(row.code), row]));

  if (args.pool) {
    const pool = loadPool(args.pool);
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (byCode.get(String(item.code))?.fetch_ok) continue;
      let result;
      try {
        result = {
          ...item,
          f100: normalizeIndustry(item.f100),
          history: compactHistory(item, lookbackYears, args.session),
          fetch_ok: true,
          fetched_at: new Date().toISOString(),
        };
      } catch (exc) {
        result = { ...item, fetch_ok: false, error: String(exc.message || exc) };
      }
      byCode.set(String(item.code), result);
      rawRows = [...byCode.values()];
      ensureParent(args.raw);
      fs.writeFileSync(
        args.raw,
        `${JSON.stringify({ schema_version: SCHEMA_VERSION, lookback_years: lookbackYears, rows: rawRows }, null, 2)}\n`,
      );
      console.log(`${i + 1}/${pool.length} ${item.code} ok=${result.fetch_ok}`);
    }
  } else if (!rawRows.length && fs.existsSync(args.raw)) {
    const existing = readJsonFile(args.raw);
    rawRows = Array.isArray(existing) ? existing : existing.rows || [];
  }
  if (!rawRows.length) {
    throw new Error("没有历史数据：请传 --pool 抓取，或用 --raw 指向已有文件");
  }

  const candidate = buildCandidate(rawRows, { minCompanies, lookbackYears });
  ensureParent(args.candidate);
  fs.writeFileSync(args.candidate, `${JSON.stringify(candidate, null, 2)}\n`);
  ensureParent(args.report);
  fs.writeFileSync(args.report, reportMarkdown(candidate, rawRows));
  console.log(`candidate: ${args.candidate}`);
  console.log(`report: ${args.report}`);
  console.log(`approved remains unchanged: ${APPROVED_ANCHOR_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

