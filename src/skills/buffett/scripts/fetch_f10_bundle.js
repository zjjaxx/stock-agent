#!/usr/bin/env node
/**
 * 抓取个股 F10 深度字段包（buffett Step 2；browser 直开 datacenter）。
 *
 * 用法:
 *   node fetch_f10_bundle.js 600900.SH -o tmp/600900_f10.json
 *   node fetch_f10_bundle.js --pool tmp/pass_pool.json -o tmp/buffett_f10.json --resume
 */

import fs from "node:fs";
import path from "node:path";
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
import { finKindFromF100 } from "./industry_map.js";

const BUNDLE_SCHEMA_VERSION = 3;

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

/** 从已实施分红方案解析每股现金分红，并按报告年度汇总（含中期/三季 + 年度）。 */
function dividendDpsHistory(mainRows) {
  const seenReports = new Set();
  const byYear = new Map();
  for (const row of byDateDesc(mainRows || [], "NOTICE_DATE")) {
    if (String(row.IS_UNASSIGN) === "1") continue;
    if (!String(row.ASSIGN_PROGRESS || "").includes("实施")) continue;
    const report = String(row.REPORT_DATE || "");
    const year = report.match(/(20\d{2})/)?.[1];
    if (!year || seenReports.has(report)) continue;
    const plan = String(row.IMPL_PLAN_PROFILE || row.IMPL_PLAN_NEWPROFILE || row.NEW_PROFILE || "");
    const match = plan.replace(/\s/g, "").match(/10(?:股)?派(?:现(?:金)?)?([\d.]+)元?/);
    if (!match) continue;
    const cashPer10 = Number(match[1]);
    if (!Number.isFinite(cashPer10) || cashPer10 <= 0) continue;
    seenReports.add(report);
    byYear.set(year, (byYear.get(year) || 0) + cashPer10 / 10);
  }
  return [...byYear.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([year, dps]) => ({ year, dps, source: "DIVIDEND_MAIN实施方案" }));
}

/** 同年派息率与每股股息历史；compre 按 STATISTICS_YEAR 从新到旧。 */
function payoutHist(compre, dupAnnual, dpsHistory) {
  const profitByYear = {};
  for (const row of dupAnnual) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const pn = fnum(row.PARENT_NETPROFIT);
    if (pn != null) profitByYear[m[1]] = pn;
  }
  const dpsByYear = Object.fromEntries((dpsHistory || []).map((row) => [String(row.year), fnum(row.dps)]));
  const years = [...compre].sort(
    (a, b) => Number(b.STATISTICS_YEAR) - Number(a.STATISTICS_YEAR),
  );
  const out = [];
  for (const c of years) {
    const y = String(c.STATISTICS_YEAR || "");
    const td = fnum(c.TOTAL_DIVIDEND);
    const pn = profitByYear[y];
    const dps = dpsByYear[y];
    if (td != null && td > 0 && ((pn != null && pn > 0) || (dps != null && dps > 0))) {
      out.push({
        pay_pct: pn != null && pn > 0 ? (td / pn) * 100 : null,
        year: y,
        source: "compre/dupont",
        total_dividend: td,
        parent_netprofit: pn ?? null,
        dps: dps ?? null,
        dps_source: dps != null ? "DIVIDEND_MAIN实施方案按报告年度汇总" : null,
      });
    }
  }
  return out;
}

function byDateDesc(rows, key = "REPORT_DATE") {
  return [...rows].sort((a, b) => String(b[key] || "").localeCompare(String(a[key] || "")));
}

function median(xs) {
  const values = xs.filter((x) => x != null).map(Number).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function metricHistory(rows, field, limit = 5) {
  return (rows || [])
    .map((row) => {
      const year = String(row.REPORT_DATE || "").match(/(20\d{2})/)?.[1] || null;
      return { year, value: fnum(row[field]) };
    })
    .filter((row) => row.value != null)
    .slice(0, limit);
}

function summarizeHistory(history) {
  const values = (history || []).map((row) => fnum(row.value)).filter((x) => x != null);
  if (!values.length) {
    return { history: [], n: 0, latest: null, median: null, min: null, max: null, stdev: null, change_pp: null };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    history,
    n: values.length,
    latest: values[0],
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    stdev: Math.sqrt(variance),
    change_pp: values.length >= 2 ? values[0] - values[values.length - 1] : null,
  };
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

/** 从 MAINFINADATA 年报抽取银/保/证专项字段。kind 只认 f100，不用字段反推。 */
function extractSpecial(finaAnnual, f100 = "", gincomeAnnual = [], finaAll = [], gbalanceAll = []) {
  const nonintByYear = {};
  const incomeByYear = {};
  for (const row of gincomeAnnual || []) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const y = m[1];
    const ratio = nonintRatioFromIncome(row);
    if (ratio != null) nonintByYear[y] = ratio;
    const mix = brokerIncomeMix(row);
    if (mix) incomeByYear[y] = mix;
  }
  const contractByYear = {};
  for (const row of gbalanceAll || []) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const y = m[1];
    const cl = fnum(row.CONTRACT_LIAB);
    const cly = fnum(row.CONTRACT_LIAB_YOY);
    const ca = fnum(row.CONTRACT_ASSET);
    const cay = fnum(row.CONTRACT_ASSET_YOY);
    const arY = fnum(row.NOTE_ACCOUNTS_RECE_YOY ?? row.ACCOUNTS_RECE_YOY);
    const noteY = fnum(row.NOTE_RECE_YOY);
    if (cl == null && cly == null && ca == null && cay == null && arY == null) continue;
    const name = String(row.REPORT_DATE_NAME || row.REPORT_TYPE || "");
    const isAnnual = name.includes("年报") || String(row.REPORT_DATE || "").includes("-12-31");
    const prev = contractByYear[y];
    const next = {
      contract_liab: cl,
      contract_liab_yoy: cly,
      contract_asset: ca,
      contract_asset_yoy: cay,
      ar_yoy: arY,
      note_rece_yoy: noteY,
      src: isAnnual ? "annual" : "interim",
    };
    if (!prev || isAnnual) contractByYear[y] = next;
    else if (prev.src !== "annual") contractByYear[y] = next;
  }
  /** 年报 TOTAL_ROI 常空：同报告年度中报/三季 TOTAL_ROI 作回退。 */
  const totalRoiFallback = {};
  for (const row of finaAll || []) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    if (!m) continue;
    const troi = fnum(row.TOTAL_ROI);
    if (troi == null) continue;
    const y = m[1];
    const name = String(row.REPORT_DATE_NAME || row.REPORT_TYPE || "");
    if (name.includes("年报")) totalRoiFallback[y] = { v: troi, src: "annual" };
    else if (!totalRoiFallback[y] || totalRoiFallback[y].src !== "annual") {
      if (name.includes("中报") || name.includes("三季")) {
        totalRoiFallback[y] = { v: troi, src: "interim" };
      } else if (!totalRoiFallback[y]) {
        totalRoiFallback[y] = { v: troi, src: "other" };
      }
    }
  }
  const years = [];
  for (const row of finaAnnual.slice(0, 5)) {
    const m = String(row.REPORT_DATE || "").match(/(20\d{2})/);
    const year = m ? m[1] : null;
    const totalRoiDirect = fnum(row.TOTAL_ROI);
    const fb = year ? totalRoiFallback[year] : null;
    const mix = year ? incomeByYear[year] || {} : {};
    const cl = year ? contractByYear[year] || {} : {};
    years.push({
      year,
      npl: fnum(row.NONPERLOAN),
      provision: fnum(row.BLDKBBL),
      cet1: fnum(row.HXYJBCZL),
      capital_adequacy: fnum(row.NEWCAPITALADER),
      tier1: fnum(row.FIRST_ADEQUACY_RATIO),
      nim: fnum(row.NET_INTEREST_MARGIN),
      solvency: fnum(row.SOLVENCY_AR),
      net_roi: fnum(row.NET_ROI),
      total_roi: totalRoiDirect != null ? totalRoiDirect : fb?.v ?? null,
      total_roi_source: totalRoiDirect != null ? "annual" : fb?.src || null,
      nbv: fnum(row.NBV_LIFE),
      nbv_rate: fnum(row.NBV_RATE),
      surrender: fnum(row.SURRENDER_RATE_LIFE),
      risk_coverage: fnum(row.RISK_COVERAGE),
      capital_leverage: fnum(row.CAPITAL_LEVERAGE_RATIO),
      pledge_cover: fnum(row.ZYGDSYLZQJZB),
      pledge_risk: fnum(row.ZQZYYWFXZB),
      proprietary_capital: fnum(row.PROPRIETARY_CAPITAL),
      interest_cover: fnum(row.INTEREST_COVERAGE_RATIO),
      interest_debt: fnum(row.INTEREST_DEBT_RATIO),
      ar_days: fnum(row.YSZKZZTS),
      inv_days: fnum(row.CHZZTS),
      rev_yoy: fnum(row.TOTALOPERATEREVETZ),
      profit_yoy: fnum(row.PARENTNETPROFITTZ),
      contract_liab: cl.contract_liab ?? null,
      contract_liab_yoy: cl.contract_liab_yoy ?? null,
      contract_asset: cl.contract_asset ?? null,
      contract_asset_yoy: cl.contract_asset_yoy ?? null,
      ar_yoy: cl.ar_yoy ?? null,
      note_rece_yoy: cl.note_rece_yoy ?? null,
      operate_reve: fnum(row.TOTALOPERATEREVE ?? row.OPERATE_INCOME_PK),
      fee_ratio: mix.fee_ratio ?? null,
      interest_ratio: mix.interest_ratio ?? null,
      invest_ratio: mix.invest_ratio ?? null,
      fee_yoy: mix.fee_yoy ?? null,
      interest_yoy: mix.interest_yoy ?? null,
      invest_yoy: mix.invest_yoy ?? null,
      npl_amt: fnum(row.NON_PERFORMING_LOAN),
      gross_loans: fnum(row.GROSSLOANS),
      overdue_loans: fnum(row.OVERDUE_LOANS),
      nonint_ratio: year && nonintByYear[year] != null ? nonintByYear[year] : null,
    });
  }
  const kind = finKindFromF100(f100);
  if (
    (kind === "brand_consumer" ||
      kind === "appliance" ||
      kind === "equip_mfg" ||
      kind === "tech_hardware") &&
    (gbalanceAll || []).length
  ) {
    const latest = [...gbalanceAll].sort((a, b) =>
      String(b.REPORT_DATE || "").localeCompare(String(a.REPORT_DATE || "")),
    )[0];
    const m = String(latest?.REPORT_DATE || "").match(/(20\d{2})/);
    const y = m ? m[1] : null;
    const cly = fnum(latest?.CONTRACT_LIAB_YOY);
    const cl = fnum(latest?.CONTRACT_LIAB);
    if (y && cly != null && years.length) {
      const hit = years.find((row) => row.year === y);
      if (hit) {
        hit.contract_liab = cl ?? hit.contract_liab;
        hit.contract_liab_yoy = cly;
      } else {
        // 禁止 unshift 残缺中期行（会冲掉年报存货天/利息保障）；把最新合同负债戳到年报 tip
        years[0] = {
          ...years[0],
          contract_liab: cl ?? years[0].contract_liab,
          contract_liab_yoy: cly,
          contract_liab_asof: y,
        };
      }
    }
  }
  if (
    kind === "bank" ||
    kind === "insurance" ||
    kind === "broker" ||
    kind === "utility" ||
    kind === "resource_cycle" ||
    kind === "brand_consumer" ||
    kind === "infra_construction" ||
    kind === "appliance" ||
    kind === "equip_mfg" ||
    kind === "tech_hardware"
  ) {
    return { kind, years, source: "RPT_F10_FINANCE_MAINFINADATA" };
  }
  return { kind: null, years, source: "RPT_F10_FINANCE_MAINFINADATA" };
}

/** 券商收入结构：手续费/利息/投资占营收%，及各自同比。 */
export function brokerIncomeMix(row) {
  const toi = fnum(row?.TOTAL_OPERATE_INCOME ?? row?.OPERATE_INCOME);
  if (!(toi > 0)) return null;
  const fee = fnum(row?.FEE_COMMISSION_INCOME);
  const ii = fnum(row?.INTEREST_INCOME);
  const inv = fnum(row?.INVEST_INCOME);
  return {
    fee_ratio: fee != null ? (fee / toi) * 100 : null,
    interest_ratio: ii != null ? (ii / toi) * 100 : null,
    invest_ratio: inv != null ? (inv / toi) * 100 : null,
    fee_yoy: fnum(row?.FEE_COMMISSION_INCOME_YOY),
    interest_yoy: fnum(row?.INTEREST_INCOME_YOY),
    invest_yoy: fnum(row?.INVEST_INCOME_YOY),
  };
}

/** 非息占比% = 1 − (利息收入−利息支出)/营业总收入。 */
export function nonintRatioFromIncome(row) {
  const toi = fnum(row?.TOTAL_OPERATE_INCOME ?? row?.OPERATE_INCOME);
  const ii = fnum(row?.INTEREST_INCOME);
  const ie = fnum(row?.INTEREST_EXPENSE);
  if (!(toi > 0) || ii == null || ie == null) return null;
  return ((toi - (ii - ie)) / toi) * 100;
}

/**
 * 非金融持久性数据：长期 ROIC 与毛利率。
 * 银行/保险/证券改由既有专项、ROE 与分红历史计算，不套普通企业口径。
 */
export function extractDurabilityEvidence(finaAnnual, kind = "corp") {
  if (kind === "bank" || kind === "insurance" || kind === "broker") return null;
  const fina = (finaAnnual || []).slice(0, 5);
  return {
    kind,
    years: [...new Set(fina.map((row) => String(row.REPORT_DATE || "").match(/(20\d{2})/)?.[1]).filter(Boolean))],
    sources: ["RPT_F10_FINANCE_MAINFINADATA"],
    roic_5y: summarizeHistory(metricHistory(fina, "ROIC")),
    gross_margin_5y: summarizeHistory(metricHistory(fina, "XSMLL")),
  };
}

function buildBundle(code, market, session, f100 = "") {
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
  const divMain = fetchReport(session, "RPT_F10_DIVIDEND_MAIN", sc, {
    pageSize: 80,
    sortColumns: "NOTICE_DATE",
  });
  const prof = fetchReport(session, "RPT_F10_DIVIDENDNEW_PROFILE", sc, { pageSize: 5 });
  const fina = fetchReport(session, "RPT_F10_FINANCE_MAINFINADATA", sc, {
    pageSize: 48,
    sortColumns: "REPORT_DATE",
  });
  const kindGuess = finKindFromF100(f100);
  let gincomeAnnual = [];
  if (kindGuess === "bank") {
    const gin = fetchReport(session, "RPT_F10_FINANCE_GINCOME", sc, {
      pageSize: 16,
      sortColumns: "REPORT_DATE",
    });
    gincomeAnnual = byDateDesc(annualRows(gin));
  }
  let gbalanceAll = [];
  if (
    kindGuess === "brand_consumer" ||
    kindGuess === "infra_construction" ||
    kindGuess === "appliance" ||
    kindGuess === "equip_mfg" ||
    kindGuess === "tech_hardware"
  ) {
    gbalanceAll = fetchReport(session, "RPT_F10_FINANCE_GBALANCE", sc, {
      pageSize: 24,
      sortColumns: "REPORT_DATE",
    });
  }

  const org0 = org[0] || {};
  const dupAnnual = byDateDesc(annualRows(dup));
  const cashAnnual = byDateDesc(annualRows(cash));
  const finaAnnual = byDateDesc(annualRows(fina));
  // 财务评分只认年报；识别失败必须暴露缺口，禁止用季度序列冒充多年历史。
  const dupA = dupAnnual;
  const cashA = cashAnnual;
  const finaA = finaAnnual;
  const special = extractSpecial(finaA, f100, gincomeAnnual, fina, gbalanceAll);

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
  const dpsHist = dividendDpsHistory(divMain);
  const payHist = payoutHist(compre, dupAnnual, dpsHist);
  const calcPay = payHist.find((row) => row.pay_pct != null) || null;
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
    schema_version: BUNDLE_SCHEMA_VERSION,
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
    durability_evidence: extractDurabilityEvidence(finaAnnual, special.kind || finKindFromF100(f100)),
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
      dividend_main: divMain.length,
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
  const payHistory = payoutHist(
    [{ STATISTICS_YEAR: "2025", TOTAL_DIVIDEND: 10 }],
    [{ REPORT_DATE: "2025-12-31", PARENT_NETPROFIT: 20 }],
    [{ year: "2025", dps: 2 }],
  );
  if (payHistory[0]?.dps !== 2 || payHistory[0]?.pay_pct !== 50) {
    fails.push(`dividend-history ${JSON.stringify(payHistory[0])}`);
  }
  const dpsHistory = dividendDpsHistory([
    { REPORT_DATE: "2025年报", NOTICE_DATE: "2026-07-01", ASSIGN_PROGRESS: "实施方案", IMPL_PLAN_PROFILE: "10派7.9元" },
    { REPORT_DATE: "2025三季报", NOTICE_DATE: "2026-02-01", ASSIGN_PROGRESS: "实施方案", IMPL_PLAN_PROFILE: "10派2.1元" },
    { REPORT_DATE: "2025半年报", NOTICE_DATE: "2025-08-01", ASSIGN_PROGRESS: "董事会预案", IMPL_PLAN_PROFILE: "10派1元" },
  ]);
  if (Math.abs((dpsHistory[0]?.dps ?? 0) - 1) > 1e-9) {
    fails.push(`dps-plan-aggregate ${JSON.stringify(dpsHistory)}`);
  }

  const durability = extractDurabilityEvidence(
    [
      { REPORT_DATE: "2025-12-31", ROIC: 12, XSMLL: 40 },
      { REPORT_DATE: "2024-12-31", ROIC: 11, XSMLL: 39 },
      { REPORT_DATE: "2023-12-31", ROIC: 10, XSMLL: 38 },
      { REPORT_DATE: "2022-12-31", ROIC: 9, XSMLL: 37 },
      { REPORT_DATE: "2021-12-31", ROIC: 8, XSMLL: 36 },
    ],
    "corp",
  );
  if (durability.roic_5y.median !== 10) {
    fails.push(`durability-roic-median ${durability.roic_5y.median}`);
  }
  if (durability.gross_margin_5y.change_pp !== 4) {
    fails.push(`durability-gross-change ${durability.gross_margin_5y.change_pp}`);
  }
  if (extractDurabilityEvidence([], "bank") !== null) {
    fails.push("bank-should-not-use-corp-durability");
  }
  const ni = nonintRatioFromIncome({
    TOTAL_OPERATE_INCOME: 100,
    INTEREST_INCOME: 80,
    INTEREST_EXPENSE: 20,
  });
  if (ni == null || Math.abs(ni - 40) > 1e-6) fails.push(`nonint-ratio ${ni}`);
  const mix = brokerIncomeMix({
    TOTAL_OPERATE_INCOME: 200,
    FEE_COMMISSION_INCOME: 80,
    INTEREST_INCOME: 60,
    INVEST_INCOME: 50,
    FEE_COMMISSION_INCOME_YOY: 12,
    INTEREST_INCOME_YOY: 8,
    INVEST_INCOME_YOY: 20,
  });
  if (!mix || Math.abs(mix.fee_ratio - 40) > 1e-6) fails.push(`broker-fee-ratio ${mix?.fee_ratio}`);
  if (!mix || mix.invest_yoy !== 20) fails.push(`broker-invest-yoy ${mix?.invest_yoy}`);
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
  if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (args.resume && outPath && fs.existsSync(outPath)) {
    const prev = readJsonFile(outPath);
    const rowsPrev = Array.isArray(prev) ? prev : prev.rows || [];
    for (const r of rowsPrev) {
      if (r.code && r.fetch_ok && r.schema_version === BUNDLE_SCHEMA_VERSION) done[r.code] = r;
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
      bundle = buildBundle(code, market, args.session, item.f100);
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
