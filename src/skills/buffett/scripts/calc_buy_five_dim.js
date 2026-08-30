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
 * - 股息率：优先估值表日频字段；否则用 F10 DIVIDEND_MAIN 除权日现金 DPS
 *   滚动近 365 天 TTM / 收盘；再回退年报 DPS 前向填充；最新点可用池内 TTM 覆盖。
 *
 * 用法:
 *   node calc_buy_five_dim.js --codes 600900,601288
 *   node calc_buy_five_dim.js --buys ~/Desktop/temp/buffett_today_buys.json \
 *     --bond ~/Desktop/temp/buffett_bond.json \
 *     -o ~/Desktop/temp/buffett_five_dim.json
 */

import fs from "node:fs";
import {
  browserFetchJson,
  buffettTmp,
  datacenterRows,
  datacenterUrl,
  marketFromCode,
  parseArgs,
  readJsonFile,
  secucode,
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

function valueAnalysisUrl(code, pageNumber = 1, pageSize = 500) {
  const filt = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  return (
    "https://datacenter-web.eastmoney.com/api/data/v1/get" +
    "?reportName=RPT_VALUEANALYSIS_DET" +
    "&columns=ALL" +
    `&filter=${filt}&pageNumber=${pageNumber}&pageSize=${pageSize}` +
    "&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB"
  );
}

function toDateStr(raw) {
  const m = String(raw || "").match(/(20\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 拉取日频估值（翻成旧→新）。分页拉满（平安约自 2018，共 ~2100 根）。 */
export function fetchValueDaily(code, session = "buffett-value") {
  const byDate = new Map();
  let page = 1;
  let pages = 1;
  while (page <= pages && page <= 20) {
    const payload = browserFetchJson(session, valueAnalysisUrl(code, page, 500), { sleepS: 0.7 });
    pages = Number(payload?.result?.pages) || 1;
    const rows = datacenterRows(payload);
    if (!rows.length) break;
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
      byDate.set(date, { date, close, pe, pb, dy });
    }
    page += 1;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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

/** 从「10派 X 元」类方案文案解析每股现金分红。 */
export function parseCashDpsFromPlan(plan) {
  const s = String(plan || "");
  let m = s.match(/10派\s*([\d.]+)/);
  if (m) return Number(m[1]) / 10;
  m = s.match(/每10股[^派]{0,12}派\s*([\d.]+)\s*元/);
  if (m) return Number(m[1]) / 10;
  m = s.match(/派息\s*([\d.]+)\s*元/);
  if (m) return Number(m[1]);
  return null;
}

function addCalendarDays(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * F10 分红实施表 → 除权日现金 DPS 事件（升序）。
 * VALUEANALYSIS 常无股息列；用此另接日频 TTM 股息率。
 */
export function fetchDividendCashEvents(code, market, session = "buffett-value") {
  const mkt = market || marketFromCode(code);
  const sc = secucode(String(code).split(".")[0], mkt);
  const url = datacenterUrl("RPT_F10_DIVIDEND_MAIN", sc, {
    pageSize: 120,
    sortColumns: "NOTICE_DATE",
  });
  const payload = browserFetchJson(session, url, { sleepS: 0.65 });
  const rows = datacenterRows(payload);
  const events = [];
  for (const row of rows) {
    if (String(row.IS_UNASSIGN) === "1") continue;
    const plan = `${row.IMPL_PLAN_PROFILE || ""}${row.NEW_PROFILE || ""}${row.IMPL_PLAN_NEWPROFILE || ""}`;
    const dps = parseCashDpsFromPlan(plan);
    const date = toDateStr(row.EX_DIVIDEND_DATE || row.EQUITY_RECORD_DATE || row.PAY_CASH_DATE);
    if (!(dps > 0) || !date) continue;
    events.push({
      date,
      dps,
      plan: plan.slice(0, 48),
      report: String(row.REPORT_DATE || ""),
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  // 同日多笔合并
  const merged = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (last && last.date === e.date) last.dps += e.dps;
    else merged.push({ ...e });
  }
  return merged;
}

/**
 * 日频股息率：
 * 1) 估值表自带 dy
 * 2) 除权日 DPS 近 365 天滚动 TTM / 收盘
 * 3) 年报 DPS 前向填充 / 收盘
 * 4) 可选：最新点用池内 TTM 覆盖
 */
export function attachDivYield(daily, payHist, currentDivPct, cashEvents = []) {
  const { byYear, years } = buildDpsFill(payHist);
  let lastDps = null;
  let yi = 0;
  let ei = 0; // cashEvents 已发生指针（升序）
  const active = []; // 窗口内事件 { date, dps }

  for (const d of daily) {
    const y = d.date.slice(0, 4);
    while (yi < years.length && years[yi] <= y) {
      lastDps = byYear[years[yi]];
      yi += 1;
    }

    if (d.dy != null && d.dy > 0) {
      d.div_pct = d.dy > 1 ? d.dy : d.dy * 100;
      d.div_source = "valueanalysis";
      continue;
    }

    while (ei < cashEvents.length && cashEvents[ei].date <= d.date) {
      active.push(cashEvents[ei]);
      ei += 1;
    }
    const start = addCalendarDays(d.date, -365);
    while (active.length && active[0].date <= start) active.shift();

    if (active.length && d.close > 0) {
      const ttmDps = active.reduce((s, e) => s + e.dps, 0);
      d.div_pct = (ttmDps / d.close) * 100;
      d.div_source = "ttm_exdiv";
      d.ttm_dps = ttmDps;
      continue;
    }

    if (lastDps != null && d.close > 0) {
      d.div_pct = (lastDps / d.close) * 100;
      d.div_source = "annual_dps_fill";
    } else {
      d.div_pct = null;
      d.div_source = null;
    }
  }

  if (currentDivPct != null && daily.length) {
    const last = daily[daily.length - 1];
    last.div_pct = currentDivPct;
    last.div_source = last.div_source ? `${last.div_source}+pool_override` : "pool_override";
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

export function analyzeOne({ code, name, bondPct, currentDiv, payHist, session, market }) {
  const raw = fetchValueDaily(code, session);
  if (raw.length < 80) {
    return { code, name, ok: false, error: `value_series_short:${raw.length}` };
  }
  const needCashDy = raw.filter((d) => d.dy != null && d.dy > 0).length < 20;
  let cashEvents = [];
  let cashErr = null;
  if (needCashDy) {
    try {
      cashEvents = fetchDividendCashEvents(code, market, session);
    } catch (exc) {
      cashErr = String(exc.message || exc);
    }
  }
  // 有 TTM 序列时不要用单点池内股息盖掉整段最新点，除非完全无股息
  const overrideLatest =
    currentDiv != null && cashEvents.length === 0 && raw.every((d) => d.dy == null || !(d.dy > 0));
  const daily = enrichMetrics(
    attachDivYield(raw, payHist, overrideLatest ? currentDiv : null, cashEvents),
    bondPct,
  );
  const latest = scoreAt(daily, daily.length - 1, WINDOW);
  if (!latest) {
    return { code, name, ok: false, error: "score_failed" };
  }
  const withDiv = daily.filter((d) => d.div_pct != null).length;
  return {
    code,
    name,
    ok: true,
    bond_yield_pct: bondPct,
    window: WINDOW,
    as_of: latest.date,
    five_dim: latest,
    series_n: daily.length,
    div_meta: {
      cash_events: cashEvents.length,
      days_with_div: withDiv,
      latest_div_pct: daily[daily.length - 1]?.div_pct ?? null,
      latest_div_source: daily[daily.length - 1]?.div_source ?? null,
      cash_error: cashErr,
    },
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
      bond: buffettTmp("buffett_bond.json"),
      session: "buffett-value",
      output: buffettTmp("buffett_five_dim.json"),
      md: buffettTmp("buffett_five_dim.md"),
    },
  });

  let items = parseCodes(args);
  let bond = { yield_pct: null };
  if (fs.existsSync(args.bond)) {
    const raw = readJsonFile(args.bond);
    bond = raw.yield_pct != null ? raw : raw.bond || raw;
  }
  const bondPct = fnum(bond.yield_pct);
  if (bondPct == null) {
    console.error("需要 --bond JSON（yield_pct）");
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

  const results = [];
  for (const it of items) {
    console.log(`five-dim ${it.code} …`);
    try {
      const r = analyzeOne({
        code: it.code,
        name: it.name || it.code,
        bondPct,
        currentDiv: fnum(it.div),
        payHist: it.pay_hist || [],
        session: args.session,
        market: it.market,
      });
      results.push(r);
      console.log(
        `  ok=${r.ok} total=${r.five_dim?.total ?? "—"} div=${r.div_meta?.latest_div_pct?.toFixed?.(2) ?? "—"}% src=${r.div_meta?.latest_div_source || "—"} n_dims=${r.five_dim?.n_dims ?? "—"}`,
      );
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
