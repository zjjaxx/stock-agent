#!/usr/bin/env node
/**
 * Step 1 硬门槛初筛（股息缺失）；连续分红年限只写入结果、不作剔除。
 * 市值只在 Step 0 召回（>1000亿），此处不再剔除。
 * 行业来自东财 f100（fetch_industry.js），供报告分册/分组。
 *
 * 用法:
 *   node step1_hard_filter.js \
 *     --pool tmp/buffett_pool.json \
 *     --streak tmp/buffett_step1_div.json \
 *     --bond 1.701 \
 *     [--industry tmp/buffett_industry.json] \
 *     -o tmp/buffett_step1.json \
 *     [--pass-json tmp/buffett_pass_pool.json]
 */

import fs from "node:fs";
import { normalizeIndustry } from "./industry_map.js";
import { parseArgs, readJsonFile } from "./opencli_json.js";
import { fetchIndustryForPool } from "./fetch_industry.js";

function loadList(path) {
  const data = readJsonFile(path);
  if (data && typeof data === "object" && Array.isArray(data.pool)) return data.pool;
  if (Array.isArray(data)) return data;
  throw new Error(`无法解析列表: ${path}`);
}

function bondPct(argsBond, bondFile) {
  if (bondFile) {
    const data = readJsonFile(bondFile);
    if (data && typeof data === "object" && data.yield_pct != null) {
      return Number(data.yield_pct);
    }
    throw new Error("bond JSON 缺少 yield_pct");
  }
  if (argsBond == null) throw new Error("需要 --bond 或 --bond-json");
  return Number(argsBond);
}

function industryByCode(pathOrNull, pool, session) {
  if (pathOrNull) {
    const rows = loadList(pathOrNull);
    return Object.fromEntries(rows.filter((r) => r.code).map((r) => [String(r.code), r]));
  }
  const rows = fetchIndustryForPool(pool, { session });
  return Object.fromEntries(rows.filter((r) => r.code).map((r) => [String(r.code), r]));
}

function mapRow(indRow) {
  const raw = indRow?.f100_raw || indRow?.f100 || indRow?.industry || "";
  const f100 = normalizeIndustry(raw);
  return {
    f100,
    f100_raw: raw || "",
    industry_source: indRow?.source || "eastmoney-ulist-f100",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: { session: "buffett-industry" },
  });
  if (!args.pool || !args.streak) {
    console.error(
      "usage: node step1_hard_filter.js --pool PATH --streak PATH --bond N [--industry PATH] [-o PATH] [--pass-json PATH]",
    );
    return 1;
  }

  let pool;
  let streakRows;
  let bond;
  let indBy;
  try {
    pool = loadList(args.pool);
    streakRows = loadList(args.streak);
    bond = bondPct(args.bond, args.bondJson || args["bond-json"]);
    indBy = industryByCode(args.industry, pool, args.session);
  } catch (exc) {
    console.error(`error: ${exc.message || exc}`);
    return 1;
  }

  const streakBy = Object.fromEntries(
    streakRows.filter((r) => r.code).map((r) => [String(r.code), r]),
  );
  const passed = [];
  const rejected = [];

  for (const row of pool) {
    const code = String(row.code || "");
    const mapped = mapRow(indBy[code]);
    const st = streakBy[code] || {};
    const div = row.div;
    const reasons = [];
    if (div == null) reasons.push("股息缺失");
    let ratio = null;
    if (div != null && bond > 0) {
      ratio = Number(div) / bond;
    }
    const item = {
      ...row,
      div_streak: st.div_streak,
      div_years: st.div_years,
      pass_div_years: st.pass_div_years,
      fetch_ok: st.fetch_ok,
      f100: mapped.f100,
      f100_raw: mapped.f100_raw,
      industry_source: mapped.industry_source,
      bond_yield_pct: bond,
      bond_ratio: ratio,
    };
    if (reasons.length) {
      item.reject_reasons = reasons;
      rejected.push(item);
    } else {
      passed.push(item);
    }
  }

  const out = {
    bond_yield_pct: bond,
    n_pool: pool.length,
    n_pass: passed.length,
    n_reject: rejected.length,
    n_missing_f100: [...passed, ...rejected].filter((r) => !r.f100).length,
    pass: passed,
    reject: rejected,
  };
  const text = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${text}\n`, "utf8");
  const passPath = args.passJson || args["pass-json"];
  if (passPath) fs.writeFileSync(passPath, `${JSON.stringify(passed, null, 2)}\n`, "utf8");
  console.log(
    `N=${pool.length} pass=${passed.length} reject=${rejected.length} bond=${bond} missing_f100=${out.n_missing_f100}`,
  );
  if (!args.output) console.log(text);
  return 0;
}

process.exit(main());
