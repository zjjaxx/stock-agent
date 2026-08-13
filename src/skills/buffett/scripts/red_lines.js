#!/usr/bin/env node
/**
 * Step 2 红线机械提示（一票否决由 Agent 复核）。
 *
 * 用法: node red_lines.js --self-test
 */

import { parseArgs } from "./opencli_json.js";

/** 净现比：常见为倍数（0.8/1.75）；偶发百分数（80）。null=无法判断。 */
export function ncoIsBelowOne(nco) {
  if (nco == null || !Number.isFinite(Number(nco))) return null;
  const v = Number(nco);
  if (Math.abs(v) > 5) return v < 100;
  return v < 1;
}

export function fcfMagnitudeGap(covers) {
  for (const c of covers || []) {
    if (c == null || !Number.isFinite(Number(c))) continue;
    if (c > 5 || c < -2) return "FCF量级哨兵(>5或<-2)，未复核单位/报告期";
  }
  return null;
}

/**
 * @param {{
 *   finKind?: "bank"|"insurance"|"corp",
 *   pay?: number|null,
 *   div?: number|null,
 *   fcfRows?: Array<{ year?: string, ocf?: number|null, profit?: number|null, nco?: number|null, cover?: number|null }>,
 *   latestProfit?: number|null,
 * }} input
 * @returns {string[]}
 */
export function collectRedFlags({
  finKind = "corp",
  pay = null,
  div = null,
  fcfRows = [],
  latestProfit = null,
} = {}) {
  const red = [];
  const bankLike = finKind === "bank" || finKind === "insurance";
  const rows = Array.isArray(fcfRows) ? fcfRows : [];

  if (pay != null && pay > 100) {
    const y0 = rows[0]?.profit;
    const y1 = rows[1]?.profit;
    let why = "须人工区分特别息/寅吃卯粮";
    if (y0 != null && y1 != null && y1 > 0 && y0 < y1 * 0.5) why = "盈利骤降但分红维持";
    red.push(`派息率>100%（${why}）`);
  }

  if (!bankLike && rows.length >= 2) {
    const a = rows[0];
    const b = rows[1];
    const ncoPair = [ncoIsBelowOne(a?.nco), ncoIsBelowOne(b?.nco)];
    const ocfPair = [
      a?.ocf != null && a?.profit != null ? a.ocf < a.profit : null,
      b?.ocf != null && b?.profit != null ? b.ocf < b.profit : null,
    ];
    const pair = ncoPair[0] != null && ncoPair[1] != null ? ncoPair : ocfPair;
    if (pair[0] === true && pair[1] === true) {
      red.push("经营现金流连续2年<净利润");
    }
    if (a?.cover != null && b?.cover != null && a.cover < 1 && b.cover < 1) {
      red.push("FCF连续2年<分红");
    }
  }

  const profit = latestProfit != null ? latestProfit : rows[0]?.profit;
  const paying = (pay != null && pay > 0) || (div != null && Number(div) > 0);
  if (profit != null && profit < 0 && paying) {
    red.push("净利润亏损仍分红");
  }

  return red;
}

function selfTest() {
  const fails = [];
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fails.push(`${label}: ${g} != ${w}`);
  };

  eq(collectRedFlags({ pay: 55, fcfRows: [] }), [], "clean");
  eq(
    collectRedFlags({ pay: 120, fcfRows: [{ profit: 10 }, { profit: 12 }] }),
    ["派息率>100%（须人工区分特别息/寅吃卯粮）"],
    "payout",
  );
  eq(
    collectRedFlags({
      pay: 120,
      fcfRows: [{ profit: 4 }, { profit: 10 }],
    }),
    ["派息率>100%（盈利骤降但分红维持）"],
    "payout-drop",
  );
  eq(
    collectRedFlags({
      fcfRows: [
        { ocf: 8, profit: 10, cover: 0.9 },
        { ocf: 7, profit: 11, cover: 0.8 },
      ],
    }),
    ["经营现金流连续2年<净利润", "FCF连续2年<分红"],
    "ocf+fcf",
  );
  eq(
    collectRedFlags({
      fcfRows: [
        { nco: 0.7, ocf: 20, profit: 10, cover: 1.2 },
        { nco: 0.8, ocf: 20, profit: 10, cover: 1.1 },
      ],
    }),
    ["经营现金流连续2年<净利润"],
    "nco-ratio",
  );
  eq(
    collectRedFlags({
      finKind: "bank",
      fcfRows: [
        { ocf: 1, profit: 10, cover: 0.2 },
        { ocf: 1, profit: 10, cover: 0.2 },
      ],
    }),
    [],
    "bank-skip",
  );
  eq(collectRedFlags({ pay: 40, latestProfit: -1, div: 4.2 }), ["净利润亏损仍分红"], "loss");
  eq(fcfMagnitudeGap([6.1]), "FCF量级哨兵(>5或<-2)，未复核单位/报告期", "sentinel");
  eq(fcfMagnitudeGap([1.2, 0.9]), null, "sentinel-ok");
  eq(ncoIsBelowOne(80), true, "nco-pct");
  eq(ncoIsBelowOne(1.2), false, "nco-ok");

  return fails;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["selfTest", "self-test"] });
  if (!(args.selfTest || args["self-test"])) {
    console.error("usage: node red_lines.js --self-test");
    return 1;
  }
  const fails = selfTest();
  if (fails.length) {
    console.error(`self-test FAIL ${fails.length}`);
    for (const f of fails) console.error(`  ${f}`);
    return 1;
  }
  console.log("self-test OK");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
