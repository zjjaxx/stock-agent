#!/usr/bin/env node
/**
 * Step 3：对硬筛通过池全部标的拉后复权日/周/月 K 线并算布林。
 * 不论质地评级 🟢/🟡/🟠/🔴/⚠️。
 *
 * 用法:
 *   node fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json
 *   node fetch_kline_pool.js --facts ~/Desktop/temp/buffett_step2_facts.json --resume
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERIODS = ["day", "week", "month"];

function codesFrom(args) {
  if (args.facts && fs.existsSync(args.facts)) {
    const data = readJsonFile(args.facts);
    return (data.cards || []).map((c) => c.code).filter(Boolean);
  }
  const pool = readJsonFile(args.pool);
  const rows = Array.isArray(pool) ? pool : pool.pool || [];
  return rows.map((r) => r.code).filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    booleans: ["resume"],
    defaults: {
      pool: path.join(buffettTmpDir(), "buffett_pass_pool.json"),
      tmp: buffettTmpDir(),
    },
  });
  const codes = [...new Set(codesFrom(args))];
  if (!codes.length) {
    console.error("error: 池内无代码");
    return 1;
  }
  const fetchJs = path.join(HERE, "fetch_kline_hfq.js");
  const bollJs = path.join(HERE, "calc_bollinger.js");
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    let codeOk = true;
    for (const period of PERIODS) {
      const klinePath = path.join(args.tmp, `${code}_${period}.json`);
      const bollPath = path.join(args.tmp, `${code}_${period}_boll.json`);
      if (args.resume && fs.existsSync(klinePath) && fs.existsSync(bollPath)) continue;
      try {
        execFileSync("node", [fetchJs, code, "--period", period, "-o", klinePath], {
          encoding: "utf8",
        });
        const bollOut = execFileSync("node", [bollJs, klinePath], { encoding: "utf8" });
        fs.writeFileSync(bollPath, bollOut, "utf8");
      } catch (exc) {
        codeOk = false;
        console.error(`${code} ${period}: ${String(exc.message || exc).slice(0, 200)}`);
      }
    }
    if (codeOk) ok += 1;
    else fail += 1;
    console.log(`${String(i + 1).padStart(2, "0")}/${codes.length} ${code} ok=${codeOk}`);
  }
  console.log(`KLINE_POOL n=${codes.length} ok=${ok} fail=${fail} dir=${args.tmp}`);
  return fail ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
