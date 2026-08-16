#!/usr/bin/env node
/**
 * 抓取个股 F10 深度字段包（buffett Step 2；browser 直开 datacenter）。
 *
 * 用法:
 *   node fetch_f10_bundle.js 600900.SH -o tmp/600900_f10.json
 *   node fetch_f10_bundle.js --pool tmp/pass_pool.json -o tmp/buffett_f10.json --resume
 */

import fs from "node:fs";
import {
  browserFetchJson,
  datacenterRows,
  datacenterUrl,
  marketFromCode,
  parseArgs,
  parseJsonText,
  readJsonFile,
  runOpencli,
  secucode,
} from "./opencli_json.js";

function annualRows(rows, dateKey = "REPORT_DATE") {
  const out = [];
  for (const row of rows) {
    const d = String(row[dateKey] || "");
    if (["-03-", "-06-", "-09-", "0331", "0630", "0930"].some((x) => d.includes(x))) {
      continue;
    }
    if (
      d.includes("-12-31") ||
      d.endsWith("12-31") ||
      String(row.REPORT_TYPE || "").includes("年报")
    ) {
      out.push(row);
    }
  }
  return out;
}

function fnum(x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/**
 * 东财 PROFILE.DIVIDEND_PAY_RATIO 固定为「分红/归母净利」小数比：
 *   0.55 → 55%；2.235 → 223.5%。
 * 不可把 >1 的倍数原样当百分数（五粮液历史事故：2.235 被写成 2.24%）。
 * 若源偶发已给百分数（>5），原样返回。
 */
function profilePayRatioToPct(raw) {
  const x = fnum(raw);
  if (x == null) return null;
  if (x <= 5) return x * 100;
  return x;
}

/** 同年 TOTAL_DIVIDEND ÷ PARENT_NETPROFIT 历年；compre 按 STATISTICS_YEAR 从新到旧 */
function payoutHist(compre, dupAnnual) {
  const profitByYear = {};
  for (const row of dupAnnual) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const pn = fnum(row.PARENT_NETPROFIT);
    if (pn != null) profitByYear[m[1]] = pn;
  }
  const years = [...compre].sort(
    (a, b) => Number(b.STATISTICS_YEAR) - Number(a.STATISTICS_YEAR),
  );
  const out = [];
  for (const c of years) {
    const y = String(c.STATISTICS_YEAR || "");
    const td = fnum(c.TOTAL_DIVIDEND);
    const pn = profitByYear[y];
    if (td != null && pn != null && pn > 0) {
      out.push({
        pay_pct: (td / pn) * 100,
        year: y,
        source: "compre/dupont",
        total_dividend: td,
        parent_netprofit: pn,
      });
    }
  }
  return out;
}

function byDateDesc(rows, key = "REPORT_DATE") {
  return [...rows].sort((a, b) => String(b[key] || "").localeCompare(String(a[key] || "")));
}

/** 高息却极低派息 → 视为口径错（如仅含部分分红金额） */
function suspiciousLowPayout(payPct, divRaw, pb) {
  if (payPct == null || payPct >= 10) return false;
  let divPct = fnum(divRaw);
  if (divPct == null) return false;
  if (divPct <= 1) divPct *= 100;
  if (divPct < 3.5) return false;
  if (pb != null && pb > 5) return false;
  return true;
}

/** COMPRE 自算与 PROFILE 相差过大 → COMPRE 年合计常残缺（漏中期/三季） */
function payoutsDiverge(calcPct, profPct, maxDiffPct = 15) {
  if (calcPct == null || profPct == null) return false;
  return Math.abs(calcPct - profPct) > maxDiffPct;
}

/**
 * 粗验：股息率 ≈ 派息率 × ROE / PB（小数口径）。
 * 两边数量级相差 ≥3 倍 → 失败（自算残缺常见形态）。
 */
function coarsePayoutFail(payPct, divRaw, roePct, pb) {
  if (payPct == null || roePct == null || pb == null || pb <= 0) return false;
  let divPct = fnum(divRaw);
  if (divPct == null) return false;
  if (divPct <= 1) divPct *= 100;
  if (divPct < 3.5) return false;
  const implied = (payPct / 100) * (roePct / 100) * (1 / pb) * 100;
  if (implied <= 0) return false;
  const ratio = divPct / implied;
  return ratio >= 3 || ratio <= 1 / 3;
}

/**
 * 选定派息率：**优先 PROFILE**（DIVIDEND_PAY_RATIO×100）；无 PROFILE 或 PROFILE
 * 触发哨兵且 COMPRE 自算更干净时，改用 compre/dupont。
 * PROFILE 哨兵：高息低派息 <10% | 股息粗验数量级偏离≥3倍。
 * COMPRE 仅作备援/交叉备注（diff 记入 reasons，不单独否决 PROFILE）。
 */
function pickPayRatio({ calcPay, profPay, divNewRaw, pb, roe3 }) {
  const notes = [];
  if (calcPay && profPay != null && payoutsDiverge(calcPay.pay_pct, profPay)) {
    notes.push("compre-diverges>15pct");
  }

  if (profPay != null) {
    const profBad = [];
    if (suspiciousLowPayout(profPay, divNewRaw, pb)) profBad.push("low-payout-sentinel");
    if (coarsePayoutFail(profPay, divNewRaw, roe3, pb)) profBad.push("coarse-identity");

    if (profBad.length === 0) {
      const tag = notes.length
        ? `profile.DIVIDEND_PAY_RATIO(${notes.join("+")})`
        : "profile.DIVIDEND_PAY_RATIO";
      return {
        pay_ratio: profPay,
        pay_ratio_source: tag,
        pay_ratio_year: calcPay?.year ?? null,
        pay_fallback_reasons: notes,
        pay_calc: calcPay,
        pay_profile: profPay,
      };
    }

    // PROFILE 异常 → 若 COMPRE 可用且未踩同样哨兵，改自算
    if (calcPay) {
      const calcBad = [];
      if (suspiciousLowPayout(calcPay.pay_pct, divNewRaw, pb)) {
        calcBad.push("low-payout-sentinel");
      }
      if (coarsePayoutFail(calcPay.pay_pct, divNewRaw, roe3, pb)) {
        calcBad.push("coarse-identity");
      }
      if (calcBad.length === 0) {
        return {
          pay_ratio: calcPay.pay_pct,
          pay_ratio_source: `compre/dupont(fallback-profile-${profBad.join("+")})`,
          pay_ratio_year: calcPay.year,
          pay_fallback_reasons: [...profBad, ...notes],
          pay_calc: calcPay,
          pay_profile: profPay,
        };
      }
    }

    return {
      pay_ratio: profPay,
      pay_ratio_source: `profile.DIVIDEND_PAY_RATIO(sentinel-suspect:${profBad.join("+")})`,
      pay_ratio_year: calcPay?.year ?? null,
      pay_fallback_reasons: [...profBad, ...notes],
      pay_calc: calcPay,
      pay_profile: profPay,
    };
  }

  if (calcPay) {
    const calcBad = [];
    if (suspiciousLowPayout(calcPay.pay_pct, divNewRaw, pb)) {
      calcBad.push("low-payout-sentinel");
    }
    if (coarsePayoutFail(calcPay.pay_pct, divNewRaw, roe3, pb)) {
      calcBad.push("coarse-identity");
    }
    return {
      pay_ratio: calcPay.pay_pct,
      pay_ratio_source:
        calcBad.length === 0
          ? calcPay.source
          : `${calcPay.source}(sentinel-suspect:${calcBad.join("+")})`,
      pay_ratio_year: calcPay.year,
      pay_fallback_reasons: calcBad,
      pay_calc: calcPay,
      pay_profile: profPay,
    };
  }

  return {
    pay_ratio: null,
    pay_ratio_source: null,
    pay_ratio_year: null,
    pay_fallback_reasons: ["no-source"],
    pay_calc: null,
    pay_profile: profPay,
  };
}

/**
 * FCF 分红总额口径（按年独立决策，禁止混用导致量级哨兵误报）：
 * 1) 优先 COMPRE.TOTAL_DIVIDEND（绝对金额）
 * 2) 若有净利×派息率隐含值，且 COMPRE/隐含 <1/3 → 视 COMPRE 残缺，改用隐含
 * 3) 仅当 COMPRE 缺失时用隐含回填
 * 派息率本身仍可优先 PROFILE；此处只统一「覆盖率分母」。
 */
export function resolveFcfDivAmounts(fcfCov, picked) {
  const rows = Array.isArray(fcfCov) ? fcfCov : [];
  const pay = fnum(picked?.pay_ratio);
  if (!rows.length) return rows;

  return rows.map((item) => {
    const compreDiv = fnum(item.div);
    // 已是 implied 的也当作「无可靠 COMPRE」
    const compreOk =
      compreDiv != null &&
      compreDiv > 0 &&
      !(item.div_source && String(item.div_source).includes("implied"));

    let impliedDiv = null;
    if (pay != null && pay > 0 && item.profit != null && item.profit > 0) {
      impliedDiv = item.profit * (pay / 100);
    }

    let div = null;
    let divSource = item.div_source || null;

    if (compreOk && impliedDiv != null && impliedDiv > 0) {
      const ratio = compreDiv / impliedDiv;
      if (ratio < 1 / 3) {
        div = impliedDiv;
        divSource = "implied:profit×pay(compre-incomplete)";
      } else {
        div = compreDiv;
        divSource = "compre.TOTAL_DIVIDEND";
      }
    } else if (compreOk) {
      div = compreDiv;
      divSource = "compre.TOTAL_DIVIDEND";
    } else if (impliedDiv != null && impliedDiv > 0) {
      div = impliedDiv;
      divSource = "implied:profit×pay";
    } else if (compreDiv != null && compreDiv > 0) {
      div = compreDiv;
      divSource = item.div_source || "compre.TOTAL_DIVIDEND";
    }

    const next = { ...item, div, div_source: divSource };
    if (item.ocf != null && item.capex != null && div) {
      next.fcf = item.ocf - item.capex;
      next.cover = next.fcf / div;
    } else {
      delete next.fcf;
      delete next.cover;
    }
    return next;
  });
}

/** @deprecated 使用 resolveFcfDivAmounts；保留别名以免旧调用炸掉 */
function patchFcfDivFromPay(fcfCov, picked) {
  return resolveFcfDivAmounts(fcfCov, picked);
}

function fetchReport(session, report, sc, opts = {}) {
  const url = datacenterUrl(report, sc, opts);
  const payload = browserFetchJson(session, url, { sleepS: 0.6 });
  return datacenterRows(payload);
}

function quoteOne(code) {
  const proc = runOpencli(["eastmoney", "quote", code, "-f", "json"], { timeoutMs: 60_000 });
  if (proc.returncode !== 0) return null;
  try {
    const data = parseJsonText(proc.stdout || "");
    if (Array.isArray(data) && data.length) {
      return data[0] && typeof data[0] === "object" ? data[0] : null;
    }
    if (data && typeof data === "object") return data;
  } catch {
    return null;
  }
  return null;
}

/** 从 MAINFINADATA 年报抽取银行/保险专项（缺字段则 null，禁止下游写死分） */
function extractSpecial(finaAnnual) {
  const years = [];
  for (const row of finaAnnual.slice(0, 3)) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    years.push({
      year: m ? m[1] : null,
      npl: fnum(row.NONPERLOAN),
      provision: fnum(row.BLDKBBL),
      cet1: fnum(row.HXYJBCZL),
      capital_adequacy: fnum(row.NEWCAPITALADER),
      tier1: fnum(row.FIRST_ADEQUACY_RATIO),
      nim: fnum(row.NET_INTEREST_MARGIN),
      solvency: fnum(row.SOLVENCY_AR),
      net_roi: fnum(row.NET_ROI),
    });
  }
  const y0 = years[0] || {};
  let kind = null;
  if (y0.npl != null || y0.provision != null || y0.cet1 != null || y0.nim != null) {
    kind = "bank";
  } else if (y0.solvency != null || y0.net_roi != null) {
    kind = "insurance";
  }
  return { kind, years, source: "RPT_F10_FINANCE_MAINFINADATA" };
}

function buildBundle(code, market, session) {
  const sc = secucode(code, market);
  const org = fetchReport(session, "RPT_F10_ORG_BASICINFO", sc, { pageSize: 5 });
  const dup = fetchReport(session, "RPT_F10_FINANCE_DUPONT", sc, {
    pageSize: 48,
    sortColumns: "REPORT_DATE",
  });
  const cash = fetchReport(session, "RPT_F10_FINANCE_GCASHFLOW", sc, {
    pageSize: 12,
    sortColumns: "REPORT_DATE",
  });
  const compre = fetchReport(session, "RPT_F10_DIVIDEND_COMPRE", sc, {
    pageSize: 16,
    sortColumns: "STATISTICS_YEAR",
  });
  const prof = fetchReport(session, "RPT_F10_DIVIDENDNEW_PROFILE", sc, { pageSize: 5 });
  const fina = fetchReport(session, "RPT_F10_FINANCE_MAINFINADATA", sc, {
    pageSize: 24,
    sortColumns: "REPORT_DATE",
  });

  const org0 = org[0] || {};
  const dupAnnual = byDateDesc(annualRows(dup));
  const cashAnnual = byDateDesc(annualRows(cash));
  const finaAnnual = byDateDesc(annualRows(fina));
  const dupA = dupAnnual.length ? dupAnnual : byDateDesc(dup.slice(0, 12));
  const cashA = cashAnnual.length ? cashAnnual : byDateDesc(cash.slice(0, 3));
  const finaA = finaAnnual.length ? finaAnnual : byDateDesc(fina.slice(0, 3));
  const special = extractSpecial(finaA);

  const roeHist = [];
  for (const row of dupA.slice(0, 10)) {
    const v = fnum(row.ROE != null ? row.ROE : row.ROEJQ);
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (v != null) roeHist.push({ year: m ? m[1] : null, roe: v });
  }
  const roeVals = roeHist.slice(0, 3).map((x) => x.roe);
  const roe3 = roeVals.length ? roeVals.reduce((a, b) => a + b, 0) / roeVals.length : null;
  const debt = dupA.length ? fnum(dupA[0].DEBT_ASSET_RATIO) : null;

  const profitByYear = {};
  const ncoByYear = {};
  for (const row of dupA) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const pn = fnum(row.PARENT_NETPROFIT);
    if (pn != null) profitByYear[m[1]] = pn;
  }
  for (const row of finaA) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const nco = fnum(row.NCO_NETPROFIT);
    if (nco != null) ncoByYear[m[1]] = nco;
    if (profitByYear[m[1]] == null) {
      const pn = fnum(row.PARENTNETPROFIT);
      if (pn != null) profitByYear[m[1]] = pn;
    }
  }

  const fcfCov = [];
  for (const yrRow of cashA.slice(0, 2)) {
    const ocf = fnum(yrRow.NETCASH_OPERATE);
    const capex = fnum(yrRow.CONSTRUCT_LONG_ASSET);
    const rd = String(yrRow.REPORT_DATE || "");
    const m = rd.match(/(20\d{2})/);
    const year = m ? m[1] : null;
    let divAmt = null;
    for (const c of compre) {
      if (String(c.STATISTICS_YEAR) === year) {
        divAmt = fnum(c.TOTAL_DIVIDEND);
        break;
      }
    }
    const item = {
      year,
      ocf,
      capex,
      div: divAmt,
      profit: year ? profitByYear[year] ?? null : null,
      nco: year ? ncoByYear[year] ?? null : null,
    };
    if (ocf != null && capex != null && divAmt) {
      const fcf = ocf - capex;
      item.fcf = fcf;
      item.cover = fcf / divAmt;
    }
    fcfCov.push(item);
  }

  const divNewRaw = prof.length ? fnum(prof[0].DIVIDEND_NEWRATIO) : null;
  const payHist = payoutHist(compre, dupA);
  const calcPay = payHist[0] || null;
  const profPay = prof.length
    ? profilePayRatioToPct(prof[0].DIVIDEND_PAY_RATIO)
    : null;

  const q = quoteOne(code);
  const pb = q ? fnum(q.priceBook) : null;

  const picked = pickPayRatio({
    calcPay,
    profPay,
    divNewRaw,
    pb,
    roe3,
  });

  // 用 COMPRE/杜邦已算净利回填 FCF 行，供隐含分红与口径交叉
  const profitFromPay = {};
  for (const p of payHist) {
    if (p.year && p.parent_netprofit != null) profitFromPay[String(p.year)] = p.parent_netprofit;
  }
  for (const item of fcfCov) {
    if (item.profit == null && item.year && profitFromPay[String(item.year)] != null) {
      item.profit = profitFromPay[String(item.year)];
    }
  }
  const fcfPatched = resolveFcfDivAmounts(fcfCov, picked);

  return {
    code,
    market,
    secucode: sc,
    fetch_ok: true,
    controller: org0.REAL_CONTROLER,
    holder: org0.CONTROL_HOLDER,
    org_form: org0.ORG_FORM,
    industry: {
      l1: org0.BOARD_NAME_1LEVEL || null,
      l2: org0.BOARD_NAME_2LEVEL || null,
      l3: org0.BOARD_NAME_3LEVEL || null,
      em2016: org0.EM2016 || null,
      csrc: org0.CSRC_INDUSTRY_NAME || null,
    },
    latest_profit: fcfPatched[0]?.profit ?? null,
    roe3,
    roe_vals: roeVals,
    roe_hist: roeHist,
    debt,
    pay_ratio: picked.pay_ratio,
    pay_ratio_source: picked.pay_ratio_source,
    pay_ratio_year: picked.pay_ratio_year,
    pay_fallback_reasons: picked.pay_fallback_reasons,
    pay_calc_pct: picked.pay_calc?.pay_pct ?? null,
    pay_profile_pct: picked.pay_profile,
    pay_hist: payHist,
    dividend_newratio: divNewRaw,
    fcf_cov: fcfPatched,
    special,
    quote: q
      ? {
          price: fnum(q.price),
          marketCap: fnum(q.marketCap),
          peDynamic: fnum(q.peDynamic),
          priceBook: fnum(q.priceBook),
          name: q.name,
        }
      : null,
    raw_counts: {
      org: org.length,
      dupont: dup.length,
      cashflow: cash.length,
      compre: compre.length,
      profile: prof.length,
      mainfina: fina.length,
    },
  };
}

function loadPool(path) {
  const data = readJsonFile(path);
  if (data && typeof data === "object" && Array.isArray(data.pool)) return data.pool;
  if (Array.isArray(data)) return data;
  throw new Error('池文件须为数组，或 {"pool": [...]}');
}

function selfTestResolveFcf() {
  const fails = [];
  const cm = resolveFcfDivAmounts(
    [
      { year: "2025", ocf: 232919e6, capex: 156951e6, div: 101808e6, profit: 137100e6 },
      { year: "2024", ocf: 315741e6, capex: 155979e6, div: 4216e6, profit: 138300e6 },
    ],
    { pay_ratio: 74.26 },
  );
  for (const row of cm) {
    if (row.cover == null || row.cover > 5 || row.cover < -2) {
      fails.push(`cm-magnitude ${row.year} cover=${row.cover}`);
    }
  }
  if (!String(cm[1].div_source || "").includes("compre-incomplete")) {
    fails.push(`cm-2024-should-replace-compre got ${cm[1].div_source}`);
  }

  const aligned = resolveFcfDivAmounts(
    [
      { year: "2025", ocf: 30e9, capex: 2e9, div: 20e9, profit: 9e9 },
      { year: "2024", ocf: 34e9, capex: 2.7e9, div: 22e9, profit: 10e9 },
    ],
    { pay_ratio: 223.5 },
  );
  if (aligned[0].div_source !== "compre.TOTAL_DIVIDEND") {
    fails.push(`aligned-keep-compre got ${aligned[0].div_source}`);
  }
  return fails;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["code"],
    defaults: { session: "buffett-f10" },
    booleans: ["resume", "selfTest", "self-test"],
  });
  if (args.selfTest || args["self-test"]) {
    const fails = selfTestResolveFcf();
    if (fails.length) {
      console.error(`self-test FAIL ${fails.length}`);
      for (const f of fails) console.error(`  ${f}`);
      return 1;
    }
    console.log("self-test OK");
    return 0;
  }
  if (!args.pool && !args.code) {
    console.error("error: 需要 code 或 --pool（或 --self-test）");
    return 1;
  }

  let items;
  if (args.pool) {
    items = loadPool(args.pool);
  } else {
    const code = String(args.code).trim();
    const mkt =
      (args.market || "").toUpperCase() ||
      (code.includes(".") ? code.split(".", 2)[1] : marketFromCode(code));
    items = [{ code: code.split(".", 2)[0], market: mkt }];
  }

  const done = {};
  const outPath = args.output || null;
  if (args.resume && outPath && fs.existsSync(outPath)) {
    const prev = readJsonFile(outPath);
    const rowsPrev = Array.isArray(prev) ? prev : prev.rows || [];
    for (const r of rowsPrev) {
      if (r.code && r.fetch_ok) done[r.code] = r;
    }
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const code = String(item.code || "").split(".", 2)[0];
    const market = String(item.market || item.MARKET_SHORT_NAME || "");
    const name = String(item.name || "");
    if (done[code]) {
      results.push(done[code]);
      console.log(`${String(i + 1).padStart(2, "0")}/${items.length} ${code} skip-resume`);
      continue;
    }
    let bundle;
    try {
      bundle = buildBundle(code, market, args.session);
      bundle.name = name || bundle.quote?.name;
    } catch (exc) {
      bundle = {
        code,
        market,
        name,
        fetch_ok: false,
        error: String(exc.message || exc),
      };
    }
    results.push(bundle);
    console.log(
      `${String(i + 1).padStart(2, "0")}/${items.length} ${code} ok=${bundle.fetch_ok} roe3=${bundle.roe3} pay=${bundle.pay_ratio}${bundle.pay_ratio_source ? `@${bundle.pay_ratio_source}` : ""}${bundle.pay_ratio_year ? `(${bundle.pay_ratio_year})` : ""}`,
    );
    if (outPath) {
      fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    }
  }

  const text = JSON.stringify(results, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${text}\n`, "utf8");
  else console.log(text);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
