#!/usr/bin/env node
/**
 * 同行组内：当前评分排名 vs 近 N 月后复权收益（默认 36）。
 * 只读 {code}_month_hfq.json；勿用前复权做含息总回报校准。
 *
 * 用法:
 *   node calc_return_peer.js
 *   node calc_return_peer.js --facts ~/Desktop/temp/buffett_step2_facts.json --months 36
 */

import fs from "node:fs";
import path from "node:path";
import { buffettTmp, buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const order = (arr) => {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = Array(arr.length);
    for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  };
  const rx = order(xs);
  const ry = order(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (!(dx > 0) || !(dy > 0)) return null;
  return num / Math.sqrt(dx * dy);
}

function monthRetHfq(tmpDir, code, months) {
  const p = path.join(tmpDir, `${code}_month_hfq.json`);
  if (!fs.existsSync(p)) return { ok: false, reason: "missing_hfq" };
  const j = readJsonFile(p);
  if (j.adjust && j.adjust !== "backward") {
    return { ok: false, reason: `bad_adjust:${j.adjust}` };
  }
  const bars = j.bars || [];
  if (bars.length < months + 1) return { ok: false, reason: `short:${bars.length}`, n: bars.length };
  const a = bars[bars.length - 1 - months];
  const b = bars[bars.length - 1];
  if (!(a?.close > 0) || !(b?.close > 0)) return { ok: false, reason: "bad_close" };
  return {
    ok: true,
    ret: b.close / a.close - 1,
    from: a.date,
    to: b.date,
    adjust: j.adjust || "backward",
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      tmp: buffettTmpDir(),
      months: "36",
    },
  });
  const months = Number(args.months) || 36;
  const facts = readJsonFile(args.facts);
  const byInd = new Map();
  let miss = 0;
  for (const c of facts.cards || []) {
    const r = monthRetHfq(args.tmp, c.code, months);
    if (!r.ok) {
      miss += 1;
      continue;
    }
    const key = c.industry_f10?.l3 || c.f100 || "?";
    if (!byInd.has(key)) byInd.set(key, []);
    byInd.get(key).push({
      code: c.code,
      name: c.name,
      rank: c.score?.rank,
      total: c.score?.total,
      ret: r.ret,
      from: r.from,
      to: r.to,
    });
  }

  const rows = [];
  for (const [ind, list] of byInd) {
    if (list.length < 2) continue;
    const rho = spearman(
      list.map((x) => x.total),
      list.map((x) => x.ret),
    );
    const byScore = [...list].sort((a, b) => a.rank - b.rank);
    const byRet = [...list].sort((a, b) => b.ret - a.ret);
    const champ = byScore[0];
    const ret1 = byRet[0];
    const champRetRank = byRet.findIndex((x) => x.code === champ.code) + 1;
    const verdict = champRetRank === 1 ? "exact" : champRetRank === 2 ? "soft" : "miss";
    rows.push({
      ind,
      n: list.length,
      rho,
      verdict,
      champ: `${champ.code} ${champ.name}`,
      champRet: champ.ret,
      ret1: `${ret1.code} ${ret1.name}`,
      ret1Ret: ret1.ret,
      champRetRank,
    });
  }
  rows.sort((a, b) => (b.rho ?? -9) - (a.rho ?? -9));

  const exact = rows.filter((r) => r.verdict === "exact").length;
  const soft = rows.filter((r) => r.verdict === "soft").length;
  const missTop = rows.filter((r) => r.verdict === "miss").length;
  const meanRho =
    rows.filter((r) => r.rho != null).reduce((s, r) => s + r.rho, 0) /
    Math.max(1, rows.filter((r) => r.rho != null).length);

  const out = {
    months,
    source: "month_hfq 后复权收盘",
    caveat: "评分是当下质地/估值分位；本脚本只检验同行组内排序与近N月后复权总回报是否同向。",
    n_groups: rows.length,
    miss_cards: miss,
    exact,
    soft,
    miss: missTop,
    mean_rho: meanRho,
    rows,
  };
  console.log(JSON.stringify(out, null, 2));
  return miss > (facts.cards || []).length / 2 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
