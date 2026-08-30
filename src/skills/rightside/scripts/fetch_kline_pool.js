#!/usr/bin/env node
/**
 * Step 2：对行业标注后的全池标的拉日/周/月 K 线。
 *
 * 先跑一次 fetch_market_context.js 拉大盘与池内全部行业板块（技术位条件 1/2/6 的底座），再逐票判技术位。
 *
 * 双复权落盘（勿混用）：
 *   - `{code}_{period}_qfq.json` → 技术位判定用（前复权）；日线另出 `{code}_stage.json`
 *   - `{code}_{period}.json` 同步为 qfq 副本（兼容旧路径）
 *   - `{code}_{period}_hfq.json` → 回测 / 近 N 年收益校准（后复权，不判阶段）
 *
 * 用法:
 *   node fetch_kline_pool.js --pool ~/Desktop/temp/rightside_pass_pool.json
 *   node fetch_kline_pool.js --hfq-only   # 只补后复权
 *   node fetch_kline_pool.js --qfq-only   # 只补前复权+阶段
 *
 * 抓数优先 opencli eastmoney kline（HTTP，不开窗）；失败才复用固定 session `rightside-kline` 浏览器回退。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, parseArgs, readJsonFile } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERIODS = ["day", "week", "month"];

function rowsFrom(args) {
  if (args.facts && fs.existsSync(args.facts)) {
    const data = readJsonFile(args.facts);
    return data.cards || [];
  }
  const pool = readJsonFile(args.pool);
  return Array.isArray(pool) ? pool : pool.pool || pool.pass || [];
}

/**
 * 技术位条件 1/2/6 需要大盘与行业上下文；缺失就现拉一份（覆盖池内全部 f100）。
 * 上下文是全池共用的，不随个股变化，所以只跑一次。
 */
function ensureContext(args, rows) {
  const ctxPath = args.context || path.join(args.tmp, "rightside_market_context.json");
  if (args.resume && fs.existsSync(ctxPath)) return ctxPath;
  const boards = [...new Set(rows.map((r) => r.f100).filter(Boolean))];
  try {
    const out = execFileSync(
      "node",
      [path.join(HERE, "fetch_market_context.js"), "--boards", boards.join(","), "-o", ctxPath],
      { encoding: "utf8" },
    );
    process.stdout.write(out);
  } catch (exc) {
    console.error(`market context failed: ${String(exc.message || exc).slice(0, 300)}`);
  }
  return ctxPath;
}

/** 全池共用一个 session；优先 eastmoney kline adapter（不开窗），仅失败时 browser 回退。 */
const KLINE_SESSION = "rightside-kline";

function fetchOne(fetchJs, code, period, adjust, outPath, { browserOnly = false } = {}) {
  const argv = [
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
  ];
  if (browserOnly) argv.push("--browser-only");
  execFileSync(
    "node",
    argv,
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLI_WINDOW: process.env.OPENCLI_WINDOW || "background" },
    },
  );
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    booleans: [
      "resume",
      "hfq-only",
      "hfqOnly",
      "qfq-only",
      "qfqOnly",
      "browser-only",
      "browserOnly",
    ],
    defaults: {
      pool: path.join(tmpDir(), "rightside_pass_pool.json"),
      tmp: tmpDir(),
      periods: PERIODS.join(","),
    },
  });
  const rows = rowsFrom(args);
  const industryByCode = new Map(rows.filter((r) => r.code).map((r) => [String(r.code), r.f100 || null]));
  const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
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
  const browserOnly = Boolean(args.browserOnly || args["browser-only"]);

  /**
   * 只拉报告真正消费的周期。技术位只用日线前复权（周线由 calc_stage 重采样），
   * 默认仍拉 day,week,month 保持兼容；主域被限流、只能走浏览器兜底时，
   * `--periods day --qfq-only` 能把单票 6 次抓取降到 1 次。
   */
  const periods = String(args.periods)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const badPeriod = periods.find((p) => !PERIODS.includes(p));
  if (badPeriod) {
    console.error(`error: 不支持的 --periods 值 ${badPeriod}（可选 ${PERIODS.join(",")}）`);
    return 1;
  }
  if (doQfq && !periods.includes("day")) {
    console.error("error: --periods 必须含 day，否则无法判技术位");
    return 1;
  }

  const fetchJs = path.join(HERE, "fetch_kline_hfq.js");
  const stageJs = path.join(HERE, "calc_stage.js");
  const contextPath = doQfq ? ensureContext(args, rows) : null;
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    let codeOk = true;
    for (const period of periods) {
      const qfqPath = path.join(args.tmp, `${code}_${period}_qfq.json`);
      const legacyPath = path.join(args.tmp, `${code}_${period}.json`);
      const stagePath = path.join(args.tmp, `${code}_stage.json`);
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
          if (!fs.existsSync(qfqPath) || !args.resume) {
            fetchOne(fetchJs, code, period, "forward", qfqPath, { browserOnly });
          }
          if (!fs.existsSync(legacyPath) || !args.resume) {
            fs.copyFileSync(qfqPath, legacyPath);
          }
          // 技术位只认日线前复权（重采样成周线后跑 30 周均线 + 六条件）。
          // 不吃 --resume：大盘/行业上下文每次都可能变，缓存的 stage 会和新上下文对不上。
          if (period === "day") {
            const stageArgs = [stageJs, qfqPath, "--context", contextPath];
            const f100 = industryByCode.get(String(code));
            if (f100) stageArgs.push("--industry", f100);
            const stageOut = execFileSync("node", stageArgs, { encoding: "utf8" });
            fs.writeFileSync(stagePath, stageOut, "utf8");
          }
        }

        if (doHfq) {
          const hfqReady = args.resume && fs.existsSync(hfqPath);
          if (!hfqReady) {
            fetchOne(fetchJs, code, period, "backward", hfqPath, { browserOnly });
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
    const sleepMs = Number(args.sleepMs || args["sleep-ms"] || 0);
    if (sleepMs > 0 && i < codes.length - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  console.log(
    `KLINE_POOL n=${codes.length} ok=${ok} fail=${fail} dir=${args.tmp} qfq=${doQfq} hfq=${doHfq} periods=${periods.join("+")}`,
  );
  return fail ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
