#!/usr/bin/env node
/**
 * Step 1 硬门槛初筛（市值 / 股息行业基准 / 连续分红 / 国债比）。
 *
 * 用法:
 *   node step1_hard_filter.js \
 *     --pool /tmp/buffett_pool.json \
 *     --streak /tmp/buffett_step1_div.json \
 *     --bond 1.701 \
 *     -o /tmp/buffett_step1.json
 */

import fs from "node:fs";
import { parseArgs, readJsonFile } from "./opencli_json.js";

const BANK = new Set([
  "601288", "601398", "601939", "601988", "601328", "601166", "600036", "601818",
  "600000", "600016", "601229", "601169", "600015", "601998", "601658", "600919",
  "600926", "002142",
]);
const OPERATOR = new Set(["600941", "601728", "600050"]);
const UTILITY = new Set(["600900", "600886", "600011"]);
const ENERGY = new Set(["601088", "601225", "601857", "600028", "600938"]);
const CYCLE = new Set(["601919", "600018", "600019"]);
const CONSTRUCT = new Set(["601668", "601390"]);
const INSURANCE = new Set(["601318", "601601", "601336"]);
const LIQUOR = new Set(["600519", "000858", "000568", "600809"]);

function industry(code, name) {
  if (BANK.has(code) || name.includes("银行")) return ["E", "银行", 4.5];
  if (OPERATOR.has(code)) return ["B", "运营商", 4.0];
  if (UTILITY.has(code) || name.includes("电力")) return ["A", "公用事业", 3.5];
  if (ENERGY.has(code) || name.includes("煤炭") || name.includes("石油")) {
    return ["C", "能源混合", 4.5];
  }
  if (CYCLE.has(code)) return ["D", "强周期", 5.5];
  if (CONSTRUCT.has(code) || name.includes("建筑")) return ["F", "建筑交运", 4.0];
  if (INSURANCE.has(code)) return ["E", "保险", 4.5];
  if (LIQUOR.has(code) || name.includes("酒")) return ["A", "白酒(公用档软参)", 3.5];
  return ["G", "通用兜底", 4.5];
}

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

function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: { minMktYi: "1000" },
  });
  if (!args.pool || !args.streak) {
    console.error("usage: node step1_hard_filter.js --pool PATH --streak PATH --bond N [-o PATH]");
    return 1;
  }

  let pool;
  let streakRows;
  let bond;
  try {
    pool = loadList(args.pool);
    streakRows = loadList(args.streak);
    bond = bondPct(args.bond, args.bondJson || args["bond-json"]);
  } catch (exc) {
    console.error(`error: ${exc.message || exc}`);
    return 1;
  }

  const minMktYi = Number(args.minMktYi || args["min-mkt-yi"] || 1000);
  const streakBy = Object.fromEntries(
    streakRows.filter((r) => r.code).map((r) => [String(r.code), r]),
  );
  const passed = [];
  const rejected = [];

  for (const row of pool) {
    const code = String(row.code || "");
    const name = String(row.name || "");
    const [cls, iname, base] = industry(code, name);
    const st = streakBy[code] || {};
    const div = row.div;
    const mktYi = row.mkt_yi;
    const reasons = [];
    if (mktYi == null || Number(mktYi) < minMktYi) reasons.push("市值");
    if (div == null || Number(div) < base) reasons.push(`股息<${base}`);
    if (!st.pass_div_years) reasons.push(`连续分红${st.div_streak ?? 0}`);
    let ratio = null;
    if (div != null && bond > 0) {
      ratio = Number(div) / bond;
      if (ratio <= 1.5) reasons.push("国债比");
    }
    const item = {
      ...row,
      div_streak: st.div_streak,
      div_years: st.div_years,
      pass_div_years: st.pass_div_years,
      fetch_ok: st.fetch_ok,
      ind_class: cls,
      ind_name: iname,
      base_div: base,
      bond_yield_pct: bond,
      bond_ratio: ratio,
      pass_bond: Boolean(ratio && ratio > 1.5),
      cycle_caution: cls === "D",
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
    pass: passed,
    reject: rejected,
  };
  const text = JSON.stringify(out, null, 2);
  if (args.output) fs.writeFileSync(args.output, `${text}\n`, "utf8");
  console.log(`N=${pool.length} pass=${passed.length} reject=${rejected.length} bond=${bond}`);
  if (!args.output) console.log(text);
  return 0;
}

process.exit(main());
