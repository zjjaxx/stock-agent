#!/usr/bin/env node
/**
 * Step 3：对硬筛通过池全部标的拉日/周/月 K 线。
 *
 * 双复权落盘（勿混用）：
 *   - `{code}_{period}_qfq.json` + `{code}_{period}_qfq_boll.json` → 今日布林（前复权）
 *   - `{code}_{period}.json` 同步为 qfq 副本（兼容旧路径）
 *   - `{code}_{period}_hfq.json` → 回测 / 近 N 年收益校准（后复权，不算布林）
 *
 * 用法:
 *   node fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json
 *   node fetch_kline_pool.js --facts ~/Desktop/temp/buffett_step2_facts.json --resume
 *   node fetch_kline_pool.js --hfq-only   # 只补后复权
 *   node fetch_kline_pool.js --qfq-only   # 只补前复权+布林
 *
 * 抓数优先 opencli eastmoney kline（HTTP，不开窗）；失败才复用固定 session `buffett-kline` 浏览器回退。
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

/** 全池共用一个 session；优先 eastmoney kline adapter（不开窗），仅失败时 browser 回退。 */
const KLINE_SESSION = "buffett-kline";

function fetchOne(fetchJs, code, period, adjust, outPath) {
  execFileSync(
    "node",
    [
      fetchJs,
      code,
      "--period",
      period,
      "--adjust",
      adjust,
      "--session",
      KLINE_SESSION,
      "-o",
      outPath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLI_WINDOW: process.env.OPENCLI_WINDOW || "background" },
    },
  );
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    booleans: ["resume", "hfq-only", "hfqOnly", "qfq-only", "qfqOnly"],
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

  const hfqOnly = args.hfqOnly || args["hfq-only"];
  const qfqOnly = args.qfqOnly || args["qfq-only"];
  if (hfqOnly && qfqOnly) {
    console.error("error: --hfq-only 与 --qfq-only 不能同时用");
    return 1;
  }
  const doQfq = !hfqOnly;
  const doHfq = !qfqOnly;

  const fetchJs = path.join(HERE, "fetch_kline_hfq.js");
  const bollJs = path.join(HERE, "calc_bollinger.js");
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    let codeOk = true;
    for (const period of PERIODS) {
      const qfqPath = path.join(args.tmp, `${code}_${period}_qfq.json`);
      const legacyPath = path.join(args.tmp, `${code}_${period}.json`);
      const bollPath = path.join(args.tmp, `${code}_${period}_qfq_boll.json`);
      const legacyBoll = path.join(args.tmp, `${code}_${period}_boll.json`);
      const hfqPath = path.join(args.tmp, `${code}_${period}_hfq.json`);

      try {
        if (doQfq) {
          // 兼容：旧路径已是前复权时迁到 *_qfq，避免整池重拉
          if (!fs.existsSync(qfqPath) && fs.existsSync(legacyPath)) {
            const legacy = readJsonFile(legacyPath);
            if (legacy.fqt === 1 || legacy.adjust === "forward") {
              fs.copyFileSync(legacyPath, qfqPath);
            }
          }
          const qfqReady = args.resume && fs.existsSync(qfqPath) && fs.existsSync(bollPath);
          if (!qfqReady) {
            if (!fs.existsSync(qfqPath) || !args.resume) {
              fetchOne(fetchJs, code, period, "forward", qfqPath);
            }
            fs.copyFileSync(qfqPath, legacyPath);
            const bollOut = execFileSync("node", [bollJs, qfqPath], { encoding: "utf8" });
            fs.writeFileSync(bollPath, bollOut, "utf8");
            fs.writeFileSync(legacyBoll, bollOut, "utf8");
          } else if (!fs.existsSync(legacyPath)) {
            fs.copyFileSync(qfqPath, legacyPath);
          }
        }

        if (doHfq) {
          const hfqReady = args.resume && fs.existsSync(hfqPath);
          if (!hfqReady) {
            fetchOne(fetchJs, code, period, "backward", hfqPath);
          }
        }
      } catch (exc) {
        codeOk = false;
        console.error(`${code} ${period}: ${String(exc.message || exc).slice(0, 200)}`);
      }
    }
    if (codeOk) ok += 1;
    else fail += 1;
    console.log(`${String(i + 1).padStart(2, "0")}/${codes.length} ${code} ok=${codeOk}`);
  }
  console.log(
    `KLINE_POOL n=${codes.length} ok=${ok} fail=${fail} dir=${args.tmp} qfq=${doQfq} hfq=${doHfq}`,
  );
  return fail ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
