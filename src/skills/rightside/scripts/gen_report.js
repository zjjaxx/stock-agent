#!/usr/bin/env node
/**
 * 生成择时定投 vs 无脑定投对比报告（Markdown 多文件）。
 *
 *   node gen_report.js --result ~/Desktop/temp/dca_backtest_result.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, readJsonFile, tmpPath } from "./opencli_json.js";

function pct(x) {
  if (x == null || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

function num(x, d = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  return Number(x).toLocaleString("zh-CN", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本金固定；终值=持仓+现金；收益相对本金。不再展示误导性的「累计买入额」。 */
function fullOverviewTable(symbols) {
  const rows = [
    "| 标的 | 策略 | 区间 | 本金 | 终值 | 持仓市值 | 剩余现金 | 收益 | CAGR | 最大回撤 | 买入次数 | 卖出次数 | 买入持有 |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of symbols) {
    for (const [label, run] of [
      ["择时定投", s.full?.timed],
      ["无脑定投", s.full?.blind],
    ]) {
      if (!run?.ok) continue;
      rows.push(
        `| ${s.name} | ${label} | ${run.start}~${run.end} | ${num(run.capital, 0)} | ${num(run.nav_end)} | ${num(run.position_end)} | ${num(run.cash_end)} | ${pct(run.return_pct)} | ${pct(run.cagr)} | ${pct(run.max_drawdown)} | ${run.buy_count} | ${run.sell_count} | ${pct(run.buy_hold_return_pct)} |`,
      );
    }
  }
  return rows.join("\n");
}

function windowTable(s) {
  const rows = [
    "| 3年窗 | 市况 | 择时收益 | 无脑收益 | 择时回撤 | 无脑回撤 | 择时终值 | 无脑终值 | BH收益 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const w of s.windows || []) {
    const t = w.timed;
    const b = w.blind;
    if (!t?.ok || !b?.ok) continue;
    rows.push(
      `| ${w.label} | ${t.bh_label} | ${pct(t.return_pct)} | ${pct(b.return_pct)} | ${pct(t.max_drawdown)} | ${pct(b.max_drawdown)} | ${num(t.nav_end)} | ${num(b.nav_end)} | ${pct(t.buy_hold_return_pct)} |`,
    );
  }
  return rows.join("\n");
}

function regimeTable(s) {
  const rows = [
    "| 市况 | 策略 | 窗口数 | 平均收益 | 平均CAGR | 平均最大回撤 | 平均相对BH |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const regime of ["牛市", "熊市", "震荡"]) {
    for (const [label, key] of [
      ["择时定投", "timed"],
      ["无脑定投", "blind"],
    ]) {
      const g = s.regime_summary?.[key]?.[regime];
      if (!g || !g.n) {
        rows.push(`| ${regime} | ${label} | 0 | — | — | — | — |`);
        continue;
      }
      rows.push(
        `| ${regime} | ${label} | ${g.n} | ${pct(g.avg_return_pct)} | ${pct(g.avg_cagr)} | ${pct(g.avg_max_drawdown)} | ${pct(g.avg_excess_vs_bh_pct)} |`,
      );
    }
  }
  return rows.join("\n");
}

function crossAssetTable(symbols) {
  const lines = [
    `| 策略 | 指标 | ${symbols.map((s) => s.name).join(" | ")} |`,
    `|---|---|${symbols.map(() => "---:").join("|")}|`,
  ];
  const metrics = [
    ["择时定投", "收益", (s) => pct(s.full?.timed?.return_pct)],
    ["择时定投", "CAGR", (s) => pct(s.full?.timed?.cagr)],
    ["择时定投", "最大回撤", (s) => pct(s.full?.timed?.max_drawdown)],
    ["择时定投", "终值", (s) => num(s.full?.timed?.nav_end)],
    ["无脑定投", "收益", (s) => pct(s.full?.blind?.return_pct)],
    ["无脑定投", "CAGR", (s) => pct(s.full?.blind?.cagr)],
    ["无脑定投", "最大回撤", (s) => pct(s.full?.blind?.max_drawdown)],
    ["无脑定投", "终值", (s) => num(s.full?.blind?.nav_end)],
  ];
  for (const [strat, metric, fn] of metrics) {
    lines.push(`| ${strat} | ${metric} | ${symbols.map(fn).join(" | ")} |`);
  }
  return lines.join("\n");
}

function bullBearDiffTable(symbols) {
  const lines = [
    "| 标的 | 市况 | 择时平均收益 | 无脑平均收益 |",
    "|---|---|---:|---:|",
  ];
  for (const s of symbols) {
    for (const regime of ["牛市", "熊市", "震荡"]) {
      const t = s.regime_summary?.timed?.[regime];
      const b = s.regime_summary?.blind?.[regime];
      if (!t?.n && !b?.n) continue;
      lines.push(
        `| ${s.name} | ${regime} | ${pct(t?.avg_return_pct)} (n=${t?.n || 0}) | ${pct(b?.avg_return_pct)} (n=${b?.n || 0}) |`,
      );
    }
  }
  return lines.join("\n");
}

function writeOverview(dir, result) {
  const p = result.params || {};
  const symbols = result.symbols || [];
  const L = [];
  L.push(`# 沪深300 · 中证红利 · 红利低波｜择时定投 vs 无脑定投回测总览`);
  L.push("");
  L.push(`生成时间：${result.as_of || new Date().toISOString()}`);
  L.push("");
  L.push(`## 0. 回测口径`);
  L.push("");
  L.push(`| 项 | 值 |`);
  L.push(`|---|---|`);
  L.push(`| 本金 | ${num(p.capital, 0)} 元（外加资金，收益相对本金） |`);
  L.push(`| 日定投 | ${num(p.daily, 0)} 元（仅用账户现金，卖出回笼可再买） |`);
  L.push(`| 底仓不卖阈值 | ${num(p.floor, 0)} 元 |`);
  L.push(`| 周期窗 | ${p.window_years} 年（非重叠） |`);
  L.push(`| 布林 | 周期 ${p.boll_period}、倍数 ${p.boll_mult} |`);
  L.push(`| 买 | ${p.buy_rule} |`);
  L.push(`| 卖 | ${p.sell_rule} |`);
  L.push(`| 无脑 | ${p.blind_rule} |`);
  L.push(`| 牛熊 | ${p.regime_rule} |`);
  L.push("");
  L.push(`> 终值 = 持仓市值 + 剩余现金。择时卖出后现金可再定投，但**本金始终是 ${num(p.capital, 0)}**，不会凭空多出投入。`);
  L.push("");
  L.push(`### 标的`);
  L.push("");
  L.push(`| key | 名称 | secid | 复权 | 信号区间 |`);
  L.push(`|---|---|---|---|---|`);
  for (const s of symbols) {
    L.push(
      `| ${s.key} | ${s.name} | ${s.secid || "—"} | ${s.adjust || "—"} | ${s.signal_range?.from || "—"} ~ ${s.signal_range?.to || "—"} |`,
    );
  }
  L.push("");
  L.push(`## 1. 全样本总览`);
  L.push("");
  L.push(fullOverviewTable(symbols));
  L.push("");
  L.push(`## 2. 标的横比（各自全样本，区间可能不同）`);
  L.push("");
  L.push(crossAssetTable(symbols));
  L.push("");
  if (result.common_period?.symbols?.length) {
    const cp = result.common_period;
    L.push(`## 2b. 重叠区间横比（${cp.from} ~ ${cp.to}）`);
    L.push("");
    L.push(`| 标的 | 择时收益 | 无脑收益 | 择时终值 | 无脑终值 | 择时回撤 | 无脑回撤 |`);
    L.push(`|---|---:|---:|---:|---:|---:|---:|`);
    for (const s of cp.symbols) {
      L.push(
        `| ${s.name} | ${pct(s.timed?.return_pct)} | ${pct(s.blind?.return_pct)} | ${num(s.timed?.nav_end)} | ${num(s.blind?.nav_end)} | ${pct(s.timed?.max_drawdown)} | ${pct(s.blind?.max_drawdown)} |`,
      );
    }
    L.push("");
  }
  L.push(`## 3. 牛市 vs 熊市（3 年窗汇总）`);
  L.push("");
  L.push(bullBearDiffTable(symbols));
  L.push("");
  L.push(`## 4. 分册`);
  L.push("");
  for (const s of symbols) {
    L.push(`- [${s.name} 明细](10-${s.key}.md)`);
  }
  L.push("");
  L.push(`---`);
  L.push("");
  L.push(`研究回测，不构成投资建议。`);
  fs.writeFileSync(path.join(dir, "00-总览.md"), `${L.join("\n")}\n`, "utf8");
}

function writeSymbolBook(dir, s) {
  const L = [];
  L.push(`# ${s.name}（${s.key}）回测明细`);
  L.push("");
  L.push(`- secid: \`${s.secid}\``);
  L.push(`- 复权: ${s.adjust}`);
  L.push(`- 数据: ${s.data_range?.first} ~ ${s.data_range?.last}`);
  L.push(`- 信号: ${s.signal_range?.from} ~ ${s.signal_range?.to}`);
  L.push(`- 日线: \`${s.day_file}\``);
  L.push("");
  L.push(`## 全样本`);
  L.push("");
  L.push(fullOverviewTable([s]));
  L.push("");
  L.push(`## 3 年窗对比`);
  L.push("");
  L.push(windowTable(s));
  L.push("");
  L.push(`## 市况汇总`);
  L.push("");
  L.push(regimeTable(s));
  fs.writeFileSync(path.join(dir, `10-${s.key}.md`), `${L.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      result: tmpPath("dca_backtest_result.json"),
    },
  });
  const resultPath = args.result;
  if (!fs.existsSync(resultPath)) {
    console.error(`缺少结果文件: ${resultPath}`);
    return 1;
  }
  const result = readJsonFile(resultPath);
  const outDir =
    args.output ||
    path.join(os.homedir(), "Desktop", `dca-compare-${stamp()}`);
  ensureDir(outDir);
  writeOverview(outDir, result);
  for (const s of result.symbols || []) writeSymbolBook(outDir, s);
  console.log(JSON.stringify({ output: outDir, overview: path.join(outDir, "00-总览.md") }, null, 2));
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main() ?? 0);
}
