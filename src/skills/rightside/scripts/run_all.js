#!/usr/bin/env node
/**
 * 一键：拉数 → 布林 → 回测 → 报告
 *
 *   node run_all.js
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpPath } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(script, args = []) {
  const r = spawnSync("node", [path.join(HERE, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`${script} failed exit=${r.status}`);
  }
}

function main() {
  run("fetch_dca_universe.js", ["--symbols", "hs300,hldf,zzhl,hldf_idx"]);
  run("calc_bollinger.js", [tmpPath("dca_hs300_day.json")]);
  run("calc_bollinger.js", [tmpPath("dca_hldf_day.json")]);
  run("calc_bollinger.js", [tmpPath("dca_zzhl_day.json")]);
  run("calc_bollinger.js", [tmpPath("dca_hldf_idx_day.json")]);
  run("run_backtest.js", [
    "--capital",
    "200000",
    "--daily",
    "500",
    "--floor",
    "100000",
    "--window-years",
    "3",
    "--hs300",
    tmpPath("dca_hs300_day.json"),
    "--hldf",
    tmpPath("dca_hldf_day.json"),
    "--zzhl",
    tmpPath("dca_zzhl_day.json"),
  ]);
  run("gen_report.js", ["--result", tmpPath("dca_backtest_result.json")]);
  return 0;
}

try {
  process.exit(main() ?? 0);
} catch (exc) {
  console.error(String(exc.message || exc));
  process.exit(1);
}
