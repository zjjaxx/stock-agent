#!/usr/bin/env node
/**
 * 批量计算连续现金分红年数（buffett Step 1）。
 *
 * 用法:
 *   node fetch_dividend_streak.js 600900.SH
 *   node fetch_dividend_streak.js --pool tmp/buffett_pool.json -o tmp/buffett_step1_div.json
 */

import fs from "node:fs";
import {
  browserFetchJson,
  datacenterRows,
  datacenterUrl,
  marketFromCode,
  parseArgs,
  readJsonFile,
  secucode,
} from "./opencli_json.js";

function isAnnualReport(reportDate) {
  const rd = reportDate || "";
  if (["半年", "中报", "季报", "一季", "三季"].some((x) => rd.includes(x))) return false;
  return rd.includes("年报") || rd.includes("年度");
}

function streakFromMain(rows) {
  const years = new Set();
  for (const row of rows) {
    if (String(row.IS_UNASSIGN) === "1") continue;
    const plan = `${row.IMPL_PLAN_PROFILE || ""}${row.NEW_PROFILE || ""}`;
    if (!plan.includes("派") && !row.TOTAL_DIVIDEND) continue;
    const rd = String(row.REPORT_DATE || "");
    if (!isAnnualReport(rd)) continue;
    const m = rd.match(/(20\d{2})/);
    if (m) years.add(Number(m[1]));
  }
  const ordered = [...years].sort((a, b) => b - a);
  if (!ordered.length) return [0, []];
  let streak = 1;
  for (let i = 0; i < ordered.length - 1; i++) {
    if (ordered[i] - ordered[i + 1] === 1) streak += 1;
    else break;
  }
  return [streak, ordered];
}

function fetchOne(sc, session) {
  const url = datacenterUrl("RPT_F10_DIVIDEND_MAIN", sc, {
    pageSize: 80,
    sortColumns: "NOTICE_DATE",
  });
  const payload = browserFetchJson(session, url, { sleepS: 0.65 });
  const rows = datacenterRows(payload);
  const [streak, years] = streakFromMain(rows);
  return {
    secucode: sc,
    div_streak: streak,
    div_years: years.slice(0, 15),
    pass_div_years: streak >= 3,
    fetch_ok: true,
    rows_n: rows.length,
  };
}

function loadPool(path) {
  const data = readJsonFile(path);
  if (data && typeof data === "object" && Array.isArray(data.pool)) return data.pool;
  if (Array.isArray(data)) return data;
  throw new Error('池文件须为数组，或 {"pool": [...]}');
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["code"],
    defaults: { session: "buffett-f10" },
    booleans: ["resume"],
  });
  if (!args.pool && !args.code) {
    console.error("error: 需要 code 或 --pool");
    return 1;
  }

  let items = [];
  if (args.pool) {
    items = loadPool(args.pool);
  } else {
    const code = String(args.code).trim();
    const mkt =
      (args.market || "").toUpperCase() ||
      (code.includes(".") ? code.split(".", 2)[1] : marketFromCode(code));
    const num = code.split(".", 2)[0];
    items = [{ code: num, market: mkt, name: "" }];
  }

  const done = {};
  const outPath = args.output || null;
  if (args.resume && outPath && fs.existsSync(outPath)) {
    const prev = readJsonFile(outPath);
    const rowsPrev = Array.isArray(prev) ? prev : prev.rows || [];
    for (const r of rowsPrev) {
      if (r.code) done[r.code] = r;
    }
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const code = String(item.code || item.SECURITY_CODE || "");
    const market = String(item.market || item.MARKET_SHORT_NAME || "");
    const name = String(item.name || item.SECURITY_SHORT_NAME || "");
    if (!code) continue;
    if (done[code]?.fetch_ok) {
      results.push(done[code]);
      console.log(`${String(i + 1).padStart(2, "0")}/${items.length} ${code} skip-resume`);
      continue;
    }
    let info;
    try {
      const sc = secucode(code, market);
      info = fetchOne(sc, args.session);
    } catch (exc) {
      info = {
        secucode: `${code}.${market}`,
        div_streak: 0,
        div_years: [],
        pass_div_years: false,
        fetch_ok: false,
        error: String(exc.message || exc),
      };
    }
    const row = { ...item, code, market, name, ...info };
    if (args.bond != null && item.div != null) {
      try {
        const ratio = Number(item.div) / Number(args.bond);
        row.bond_ratio = ratio;
      } catch {
        /* ignore */
      }
    }
    results.push(row);
    console.log(
      `${String(i + 1).padStart(2, "0")}/${items.length} ${code} ${name} streak=${row.div_streak} ok=${row.fetch_ok}`,
    );
    if (outPath) {
      fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    }
  }

  const text = JSON.stringify(results, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${text}\n`, "utf8");
  else console.log(text);

  const bad = results.filter((r) => !r.fetch_ok).length;
  return bad && !args.pool ? 1 : 0;
}

process.exit(main());
