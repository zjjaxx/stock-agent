#!/usr/bin/env node
/**
 * Step3：对「今日建仓建议」票做五维自身分位估值。
 *
 * 五维（近 2 年≈504 交易日滚动窗口，相对自身历史）：
 *   PE、PB、现价 —— 越低越好 → score = 100 − 分位
 *   ERP = 1/PE − 国债10Y（小数） —— 越高越好 → score = 分位
 *   DRP = 股息率 − 国债10Y（小数） —— 越高越好 → score = 分位
 *   总分 = 可用维等权均值
 *
 * 股息率历史：优先 VALUEANALYSIS 日频字段；否则用年报 DPS/收盘前向填充。
 * 国债：整段用当前 bond.yield_pct（无历史国债曲线时的约定）。
 *
 * 用法:
 *   node calc_buy_five_dim.js --codes 600900,601288
 *   node calc_buy_five_dim.js --buys ~/Desktop/temp/buffett_today_buys.json \
 *     --facts ~/Desktop/temp/buffett_step2_facts.json \
 *     --bond ~/Desktop/temp/buffett_bond.json \
 *     -o ~/Desktop/temp/buffett_five_dim.json
 */

import fs from "node:fs";
import {
  browserFetchJson,
  buffettTmp,
  datacenterRows,
  parseArgs,
  readJsonFile,
} from "./opencli_json.js";

const WINDOW = 504; // ~2Y trading days

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function pctRank(sortedAsc, value) {
  if (value == null || !sortedAsc.length) return null;
  let lo = 0;
  for (const x of sortedAsc) {
    if (x < value) lo += 1;
    else break;
  }
  let hi = lo;
  while (hi < sortedAsc.length && sortedAsc[hi] === value) hi += 1;
  const avgRank = (lo + hi - 1) / 2; // 0-based average rank of ties
  return (avgRank / (sortedAsc.length - 1 || 1)) * 100;
}

function percentileOf(values, current) {
  const xs = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length < 20 || current == null || !Number.isFinite(current)) return null;
  return pctRank(xs, current);
}

function valueAnalysisUrl(code) {
  const filt = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  return (
    "https://datacenter-web.eastmoney.com/api/data/v1/get" +
    "?reportName=RPT_VALUEANALYSIS_DET" +
    "&columns=ALL" +
    `&filter=${filt}&pageNumber=1&pageSize=1400` +
    "&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB"
  );
}

function toDateStr(raw) {
  const m = String(raw || "").match(/(20\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 拉取日频估值（新→旧），再翻成旧→新。 */
export function fetchValueDaily(code, session = "buffett-value") {
  const payload = browserFetchJson(session, valueAnalysisUrl(code), { sleepS: 0.8 });
  const rows = datacenterRows(payload);
  const daily = [];
  for (const r of rows) {
    const date = toDateStr(r.TRADE_DATE);
    const close = fnum(r.CLOSE_PRICE);
    if (!date || !(close > 0)) continue;
    const pe = fnum(r.PE_TTM);
    const pb = fnum(r.PB_MRQ);
    const dy =
      fnum(r.DIVIDEND_RATIO) ??
      fnum(r.DV_TTM) ??
      fnum(r.DIVIDEND_RATE) ??
      fnum(r.DVD_RATE) ??
      null;
    daily.push({ date, close, pe, pb, dy });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return daily;
}

function buildDpsFill(payHist) {
  const byYear = {};
  for (const row of payHist || []) {
    const y = String(row.year || "");
    const dps = fnum(row.dps);
    if (y && dps != null && dps > 0) byYear[y] = dps;
  }
  const years = Object.keys(byYear).sort();
  return { byYear, years };
}

function attachDivYield(daily, payHist, currentDivPct) {
  const { byYear, years } = buildDpsFill(payHist);
  let lastDps = null;
  let yi = 0;
  for (const d of daily) {
    const y = d.date.slice(0, 4);
    while (yi < years.length && years[yi] <= y) {
      lastDps = byYear[years[yi]];
      yi += 1;
    }
    if (d.dy != null && d.dy > 0) {
      d.div_pct = d.dy > 1 ? d.dy : d.dy * 100; // 有的源给小数
      continue;
    }
    if (lastDps != null && d.close > 0) d.div_pct = (lastDps / d.close) * 100;
    else d.div_pct = null;
  }
  if (currentDivPct != null && daily.length) {
    daily[daily.length - 1].div_pct = currentDivPct;
  }
  return daily;
}

function enrichMetrics(daily, bondPct) {
  const rf = bondPct / 100;
  for (const d of daily) {
    d.erp = d.pe != null && d.pe > 0 ? 1 / d.pe - rf : null;
    d.drp = d.div_pct != null ? d.div_pct / 100 - rf : null;
  }
  return daily;
}

function dimScore(pct, higherBetter) {
  if (pct == null) return null;
  return higherBetter ? pct : 100 - pct;
}

function windowSlice(daily, endIdx, window = WINDOW) {
  const start = Math.max(0, endIdx - window + 1);
  return daily.slice(start, endIdx + 1);
}

function scoreAt(daily, endIdx, window = WINDOW) {
  const win = windowSlice(daily, endIdx, window);
  if (win.length < 60) return null;
  const cur = daily[endIdx];
  const pePct = percentileOf(
    win.map((d) => d.pe),
    cur.pe,
  );
  const pbPct = percentileOf(
    win.map((d) => d.pb),
    cur.pb,
  );
  const pricePct = percentileOf(
    win.map((d) => d.close),
    cur.close,
  );
  const erpPct = percentileOf(
    win.map((d) => d.erp),
    cur.erp,
  );
  const drpPct = percentileOf(
    win.map((d) => d.drp),
    cur.drp,
  );
  const dims = {
    pe: { value: cur.pe, pct: pePct, score: dimScore(pePct, false), higher_better: false },
    pb: { value: cur.pb, pct: pbPct, score: dimScore(pbPct, false), higher_better: false },
    erp: { value: cur.erp, pct: erpPct, score: dimScore(erpPct, true), higher_better: true },
    drp: { value: cur.drp, pct: drpPct, score: dimScore(drpPct, true), higher_better: true },
    price: { value: cur.close, pct: pricePct, score: dimScore(pricePct, false), higher_better: false },
  };
  const usable = Object.values(dims).filter((d) => d.score != null);
  const total =
    usable.length >= 3
      ? Math.round((usable.reduce((s, d) => s + d.score, 0) / usable.length) * 10) / 10
      : null;
  return { date: cur.date, dims, total, n_win: win.length, n_dims: usable.length };
}

export function analyzeOne({ code, name, bondPct, currentDiv, payHist, session }) {
  const raw = fetchValueDaily(code, session);
  if (raw.length < 80) {
    return { code, name, ok: false, error: `value_series_short:${raw.length}` };
  }
  const daily = enrichMetrics(attachDivYield(raw, payHist, currentDiv), bondPct);
  const latest = scoreAt(daily, daily.length - 1, WINDOW);
  if (!latest) {
    return { code, name, ok: false, error: "score_failed" };
  }
  return {
    code,
    name,
    ok: true,
    bond_yield_pct: bondPct,
    window: WINDOW,
    as_of: latest.date,
    five_dim: latest,
    series_n: daily.length,
  };
}

function parseCodes(args) {
  if (args.codes) {
    return String(args.codes)
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((c) => ({ code: c.split(".")[0], market: c.includes(".") ? c.split(".")[1] : null, name: c }));
  }
  if (args.buys) {
    const buys = readJsonFile(args.buys);
    const list = Array.isArray(buys) ? buys : buys.buys || buys.codes || [];
    return list.map((x) =>
      typeof x === "string"
        ? { code: x.split(".")[0], name: x, market: null }
        : { code: String(x.code).split(".")[0], name: x.name || x.code, market: x.market || null, div: x.div, pay_hist: x.pay_hist },
    );
  }
  return [];
}

function renderMd(results) {
  const L = [];
  L.push("# 今日建仓 · 五维估值");
  L.push("");
  L.push(
    "五维自身分位（近2年滚动）：PE / PB / 现价越低越好；ERP=`1/PE−国债`、DRP=`股息率−国债` 越高越好。总分=可用维等权。",
  );
  L.push("");
  L.push("| 代码 | 简称 | 总分 | PE分位 | PB分位 | ERP分位 | DRP分位 | 现价分位 |");
  L.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    if (!r.ok) {
      L.push(`| ${r.code} | ${r.name || "—"} | — | — | — | — | — | ${r.error || "失败"} |`);
      continue;
    }
    const d = r.five_dim.dims;
    const fmtP = (x) => (x == null ? "—" : x.toFixed(1));
    const fmtS = (x) => (x == null ? "—" : String(x));
    L.push(
      `| ${r.code} | ${r.name || "—"} | **${fmtS(r.five_dim.total)}** | ${fmtP(d.pe.pct)} | ${fmtP(d.pb.pct)} | ${fmtP(d.erp.pct)} | ${fmtP(d.drp.pct)} | ${fmtP(d.price.pct)} |`,
    );
  }
  L.push("");
  for (const r of results.filter((x) => x.ok)) {
    L.push(`## ${r.code} ${r.name || ""}`);
    L.push("");
    L.push(`- as_of=${r.as_of}｜窗口 n=${r.five_dim.n_win}｜可用维 ${r.five_dim.n_dims}/5｜国债 ${r.bond_yield_pct}%`);
    L.push(
      `- ERP=${r.five_dim.dims.erp.value != null ? (r.five_dim.dims.erp.value * 100).toFixed(2) + "%" : "—"}｜DRP=${r.five_dim.dims.drp.value != null ? (r.five_dim.dims.drp.value * 100).toFixed(2) + "%" : "—"}`,
    );
    L.push("");
  }
  return L.join("\n") + "\n";
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      bond: buffettTmp("buffett_bond.json"),
      session: "buffett-value",
      output: buffettTmp("buffett_five_dim.json"),
      md: buffettTmp("buffett_five_dim.md"),
    },
  });

  let items = parseCodes(args);
  const facts = fs.existsSync(args.facts) ? readJsonFile(args.facts) : null;
  let bond = { yield_pct: null };
  if (fs.existsSync(args.bond)) {
    const raw = readJsonFile(args.bond);
    bond = raw.yield_pct != null ? raw : raw.bond || raw;
  } else if (facts?.bond) {
    bond = facts.bond;
  }
  const bondPct = fnum(bond.yield_pct);
  if (bondPct == null) {
    console.error("需要 --bond JSON（yield_pct）或 facts.bond");
    return 1;
  }

  if (!items.length && args.buys) {
    console.error("buys 文件无代码");
    return 1;
  }
  if (!items.length) {
    console.error("usage: node calc_buy_five_dim.js --codes 600900,601288 | --buys buys.json");
    return 1;
  }

  const cardBy = {};
  for (const c of facts?.cards || []) cardBy[String(c.code)] = c;

  const results = [];
  for (const it of items) {
    const card = cardBy[it.code] || {};
    console.log(`five-dim ${it.code} …`);
    try {
      const r = analyzeOne({
        code: it.code,
        name: it.name || card.name || it.code,
        bondPct,
        currentDiv: fnum(it.div) ?? fnum(card.div),
        payHist: it.pay_hist || card.pay_hist || [],
        session: args.session,
      });
      results.push(r);
      console.log(`  ok=${r.ok} total=${r.five_dim?.total ?? "—"}`);
    } catch (exc) {
      results.push({ code: it.code, name: it.name, ok: false, error: String(exc.message || exc) });
      console.error(`  error: ${exc.message || exc}`);
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    bond_yield_pct: bondPct,
    window: WINDOW,
    results,
  };
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const mdPath = args.md || args["md-out"];
  if (mdPath) fs.writeFileSync(mdPath, renderMd(results), "utf8");
  console.log(`FIVE_DIM_JSON=${args.output}`);
  if (mdPath) console.log(`FIVE_DIM_MD=${mdPath}`);
  console.log(`K=${results.filter((r) => r.ok).length}/${results.length}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
