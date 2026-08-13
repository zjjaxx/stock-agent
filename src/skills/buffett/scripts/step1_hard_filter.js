#!/usr/bin/env node
/**
 * Step 1 硬门槛初筛（连续分红 / 股息缺失）。
 * 市值只在 Step 0 召回（>1000亿），此处不再剔除。
 * 行业来自东财 f100（fetch_industry.js），写入结果供 Step2 事实卡画像参考。
 * 股息相对国债的召回只在 Step 0（≥ 国债×2）；此处只算 bond_ratio 供排序展示。
 *
 * 用法:
 *   node step1_hard_filter.js \
 *     --pool /tmp/buffett_pool.json \
 *     --streak /tmp/buffett_step1_div.json \
 *     --bond 1.701 \
 *     [--industry /tmp/buffett_industry.json] \
 *     -o /tmp/buffett_step1.json
 */

import fs from "node:fs";
import { parseArgs, readJsonFile } from "./opencli_json.js";
import { fetchIndustryForPool } from "./fetch_industry.js";
import { CLASS_META, classifyIndustry } from "./industry_map.js";

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
  if (indRow?.cls && CLASS_META[indRow.cls]) {
    return {
      cls: indRow.cls,
      ind_name: indRow.ind_name || CLASS_META[indRow.cls].name,
      cycle_caution: Boolean(indRow.cycle_caution),
      unmapped: Boolean(indRow.unmapped),
      f100: indRow.f100 || indRow.industry || "",
      industry_source: indRow.source || "eastmoney-ulist-f100",
    };
  }
  const mapped = classifyIndustry({ f100: indRow?.f100 || indRow?.industry });
  return {
    cls: mapped.cls,
    ind_name: mapped.ind_name,
    cycle_caution: mapped.cycle_caution,
    unmapped: mapped.unmapped,
    f100: mapped.industry || "",
    industry_source: indRow?.source || "classify",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: { session: "buffett-industry" },
  });
  if (!args.pool || !args.streak) {
    console.error(
      "usage: node step1_hard_filter.js --pool PATH --streak PATH --bond N [--industry PATH] [-o PATH]",
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
    if (!st.pass_div_years) reasons.push(`连续分红${st.div_streak ?? 0}`);
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
      ind_class: mapped.cls,
      ind_name: mapped.ind_name,
      f100: mapped.f100,
      industry_source: mapped.industry_source,
      ind_unmapped: mapped.unmapped,
      bond_yield_pct: bond,
      bond_ratio: ratio,
      cycle_caution: mapped.cycle_caution,
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
    n_unmapped: [...passed, ...rejected].filter((r) => r.ind_unmapped).length,
    pass: passed,
    reject: rejected,
  };
  const text = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${text}\n`, "utf8");
  console.log(
    `N=${pool.length} pass=${passed.length} reject=${rejected.length} bond=${bond} unmapped=${out.n_unmapped}`,
  );
  if (!args.output) console.log(text);
  return 0;
}

process.exit(main());
