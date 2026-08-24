#!/usr/bin/env node
/**
 * 用后复权月线算近 N 年收益，并与事实卡同行排名对照（回测/校准用）。
 * 禁止用前复权序列做这项检验。
 *
 * 用法:
 *   node calc_peer_returns_hfq.js
 *   node calc_peer_returns_hfq.js --months 36 --facts ~/Desktop/temp/buffett_step2_facts.json
 */

import fs from "node:fs";
import { buffettTmp, buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";
import { assignPeerRanks } from "./score_numeric.js";
import { buildIndustryBacktest } from "./peer_returns_hfq.js";

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      tmp: buffettTmpDir(),
      months: "36",
      output: buffettTmp("buffett_rank_vs_3y_hfq.json"),
    },
  });
  const months = Number(args.months) || 36;
  const facts = readJsonFile(args.facts);
  const cards = [...(facts.cards || [])];
  assignPeerRanks(cards);

  const byInd = buildIndustryBacktest(cards, args.tmp, { months });
  const industries = [];
  const missing = [];
  let exact = 0;
  let soft = 0;
  let miss = 0;
  const rhos = [];

  for (const bt of byInd.values()) {
    if (bt.missing?.length) missing.push(...bt.missing);
    if (bt.verdict === "exact") exact += 1;
    else if (bt.verdict === "soft") soft += 1;
    else if (bt.verdict === "miss") miss += 1;
    if (bt.rho != null) rhos.push(bt.rho);
    if (bt.verdict === "solo" || bt.verdict === "nodata") continue;
    industries.push({
      ind: bt.key,
      n: bt.byScore?.length ?? bt.members.length,
      rho: bt.rho,
      verdict: bt.verdict,
      champ: bt.champ,
      ret1: bt.ret1,
      champRetRank: bt.champRetRank,
      members: bt.byScore,
    });
  }

  const payload = {
    asof: new Date().toISOString(),
    source: "后复权月线 close（fqt=2 / *_month_hfq.json）",
    months,
    caveat:
      "排名是当下质地分，不是 N 年前的排名。收益用后复权近似含息路径；勿与前复权布林混比绝对价。",
    nCards: cards.length,
    nWithRet: cards.length - missing.length,
    missingN: missing.length,
    missing: missing.slice(0, 20),
    nIndCmp: industries.length,
    exact,
    soft,
    miss,
    meanRho: rhos.length ? rhos.reduce((a, b) => a + b, 0) / rhos.length : null,
    industries,
  };

  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `RANK_VS_${months}M_HFQ exact=${exact} soft=${soft} miss=${miss} meanRho=${payload.meanRho?.toFixed?.(3) ?? "—"} out=${args.output} missing=${missing.length}`,
  );
  return missing.length && industries.length === 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
