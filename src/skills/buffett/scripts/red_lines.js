#!/usr/bin/env node
/**
 * Step1 红线机械提示（一票否决由 Agent 复核）。
 *
 * hard：默认倾向终评回避（仍须 Agent 复核属实）。
 * soft：提示/观察，不自动一票否决（如特别分红且 FCF 覆盖健康）。
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

function coversWithData(fcfRows) {
  return (Array.isArray(fcfRows) ? fcfRows : [])
    .map((r) => r?.cover)
    .filter((c) => c != null && Number.isFinite(Number(c)))
    .map(Number);
}

/**
 * 派息>100% 分支：
 * - 盈利腰斩仍高派 → hard「盈利骤降」
 * - 近两年有 cover 且全部 ≥1 → soft「特别分红倾向」
 * - 任一年 cover<1 → hard「寅吃卯粮」
 * - 无 cover → soft「须人工区分」（不自动否决）
 */
export function classifyPayoutOver100({ pay, fcfRows = [], profit0 = null, profit1 = null } = {}) {
  if (pay == null || !(pay > 100)) return null;
  if (profit0 != null && profit1 != null && profit1 > 0 && profit0 < profit1 * 0.5) {
    return {
      tier: "hard",
      message: "派息率>100%（盈利骤降但分红维持）",
    };
  }
  const covers = coversWithData(fcfRows);
  if (covers.length > 0 && covers.every((c) => c >= 1)) {
    return {
      tier: "soft",
      message: "派息率>100%（特别分红倾向，FCF覆盖健康——不自动一票否决）",
    };
  }
  if (covers.some((c) => c < 1)) {
    return {
      tier: "hard",
      message: "派息率>100%（寅吃卯粮：FCF盖不住分红）",
    };
  }
  return {
    tier: "soft",
    message: "派息率>100%（须人工区分特别息/寅吃卯粮——缺FCF覆盖，不自动否决）",
  };
}

/**
 * @param {{
 *   finKind?: "bank"|"insurance"|"broker"|"corp"|string,
 *   pay?: number|null,
 *   div?: number|null,
 *   fcfRows?: Array<{ year?: string, ocf?: number|null, profit?: number|null, nco?: number|null, cover?: number|null }>,
 *   latestProfit?: number|null,
 * }} input
 * @returns {{ hard: string[], soft: string[] }}
 */
export function collectRedFlags({
  finKind = "corp",
  pay = null,
  div = null,
  fcfRows = [],
  latestProfit = null,
} = {}) {
  const hard = [];
  const soft = [];
  const bankLike = finKind === "bank" || finKind === "insurance" || finKind === "broker";
  const rows = Array.isArray(fcfRows) ? fcfRows : [];

  const payoutFlag = classifyPayoutOver100({
    pay,
    fcfRows: rows,
    profit0: rows[0]?.profit,
    profit1: rows[1]?.profit,
  });
  if (payoutFlag?.tier === "hard") hard.push(payoutFlag.message);
  else if (payoutFlag?.tier === "soft") soft.push(payoutFlag.message);

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
      hard.push("经营现金流连续2年<净利润");
    }
    if (a?.cover != null && b?.cover != null && a.cover < 1 && b.cover < 1) {
      hard.push("FCF连续2年<分红");
    }
  }

  const profit = latestProfit != null ? latestProfit : rows[0]?.profit;
  const paying = (pay != null && pay > 0) || (div != null && Number(div) > 0);
  if (profit != null && profit < 0 && paying) {
    hard.push("净利润亏损仍分红");
  }

  return { hard, soft };
}

/** 兼容旧调用：只返回 hard 列表。 */
export function collectRedFlagList(input) {
  return collectRedFlags(input).hard;
}

function selfTest() {
  const fails = [];
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fails.push(`${label}: ${g} != ${w}`);
  };

  eq(collectRedFlags({ pay: 55, fcfRows: [] }), { hard: [], soft: [] }, "clean");
  eq(
    collectRedFlags({
      pay: 223,
      fcfRows: [
        { profit: 10, cover: 1.4 },
        { profit: 12, cover: 1.4 },
      ],
    }),
    {
      hard: [],
      soft: ["派息率>100%（特别分红倾向，FCF覆盖健康——不自动一票否决）"],
    },
    "special-div",
  );
  eq(
    collectRedFlags({
      pay: 113,
      fcfRows: [
        { profit: 7, cover: 0.81 },
        { profit: 6, cover: 1.1 },
      ],
    }),
    {
      hard: ["派息率>100%（寅吃卯粮：FCF盖不住分红）"],
      soft: [],
    },
    "payout-fcf-weak",
  );
  eq(
    collectRedFlags({
      pay: 120,
      fcfRows: [{ profit: 4 }, { profit: 10 }],
    }),
    {
      hard: ["派息率>100%（盈利骤降但分红维持）"],
      soft: [],
    },
    "payout-drop",
  );
  eq(
    collectRedFlags({
      pay: 120,
      fcfRows: [],
    }),
    {
      hard: [],
      soft: ["派息率>100%（须人工区分特别息/寅吃卯粮——缺FCF覆盖，不自动否决）"],
    },
    "payout-no-fcf",
  );
  eq(
    collectRedFlags({
      fcfRows: [
        { ocf: 8, profit: 10, cover: 0.9 },
        { ocf: 7, profit: 11, cover: 0.8 },
      ],
    }),
    {
      hard: ["经营现金流连续2年<净利润", "FCF连续2年<分红"],
      soft: [],
    },
    "ocf+fcf",
  );
  eq(
    collectRedFlags({
      fcfRows: [
        { nco: 0.7, ocf: 20, profit: 10, cover: 1.2 },
        { nco: 0.8, ocf: 20, profit: 10, cover: 1.1 },
      ],
    }),
    {
      hard: ["经营现金流连续2年<净利润"],
      soft: [],
    },
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
    { hard: [], soft: [] },
    "bank-skip",
  );
  eq(
    collectRedFlags({
      finKind: "broker",
      fcfRows: [
        { ocf: 1, profit: 10, cover: 0.2 },
        { ocf: 1, profit: 10, cover: 0.2 },
      ],
    }),
    { hard: [], soft: [] },
    "broker-skip-fcf",
  );
  eq(
    collectRedFlags({ pay: 40, latestProfit: -1, div: 4.2 }),
    { hard: ["净利润亏损仍分红"], soft: [] },
    "loss",
  );
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
