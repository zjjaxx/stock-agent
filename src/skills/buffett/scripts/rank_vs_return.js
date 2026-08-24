#!/usr/bin/env node
/**
 * 用后复权月线核对「同行评分排序 ↔ 近 N 年收益」。
 * 只读 `{code}_month_hfq.json`；不改评分、不进买卖。
 *
 * 用法:
 *   node rank_vs_return.js
 *   node rank_vs_return.js --months 36 --facts ~/Desktop/temp/buffett_step2_facts.json
 */

import fs from "node:fs";
import path from "node:path";
import { buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";
import { assignPeerRanks } from "./score_numeric.js";

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const order = (arr) => {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
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

function hfqMonthRet(tmp, code, months) {
  const p = path.join(tmp, `${code}_month_hfq.json`);
  if (!fs.existsSync(p)) return { ok: false, reason: "missing_hfq" };
  const j = readJsonFile(p);
  if (j.fqt !== 2 && j.adjust !== "backward") {
    return { ok: false, reason: `not_hfq fqt=${j.fqt}` };
  }
  const bars = j.bars || [];
  if (bars.length < months + 1) return { ok: false, reason: `short n=${bars.length}` };
  const a = bars[bars.length - 1 - months];
  const b = bars[bars.length - 1];
  if (!(a?.close > 0) || !(b?.close > 0)) return { ok: false, reason: "bad_close" };
  return {
    ok: true,
    ret: b.close / a.close - 1,
    from: a.date,
    to: b.date,
    n: bars.length,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: path.join(buffettTmpDir(), "buffett_step2_facts.json"),
      tmp: buffettTmpDir(),
      months: "36",
    },
  });
  const months = Number(args.months) || 36;
  const facts = readJsonFile(args.facts);
  const cards = [...(facts.cards || [])];
  assignPeerRanks(cards);

  const byInd = new Map();
  let miss = 0;
  for (const c of cards) {
    const r = hfqMonthRet(args.tmp, c.code, months);
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
    const verdict =
      champ.code === ret1.code ? "exact" : champRetRank === 2 ? "soft" : "miss";
    rows.push({
      ind,
      n: list.length,
      rho,
      verdict,
      champ: champ.name,
      champRet: champ.ret,
      ret1: ret1.name,
      ret1ret: ret1.ret,
      champRetRank,
    });
  }
  rows.sort((a, b) => (b.rho ?? -9) - (a.rho ?? -9));

  const exact = rows.filter((r) => r.verdict === "exact").length;
  const soft = rows.filter((r) => r.verdict === "soft").length;
  const bad = rows.filter((r) => r.verdict === "miss").length;
  const meanRho =
    rows.filter((r) => r.rho != null).reduce((s, r) => s + r.rho, 0) /
    Math.max(1, rows.filter((r) => r.rho != null).length);

  const out = {
    asof: new Date().toISOString(),
    source: "后复权月线 close（*_month_hfq.json）",
    months,
    miss_hfq: miss,
    n_groups: rows.length,
    exact,
    soft,
    miss: bad,
    mean_rho: meanRho,
    rows,
  };
  const outPath = path.join(args.tmp, "buffett_rank_vs_return_hfq.json");
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `groups=${rows.length} exact=${exact} soft=${soft} miss=${bad} meanρ=${meanRho.toFixed(3)} miss_hfq=${miss}`,
  );
  console.log(`OUT=${outPath}`);
  for (const r of rows) {
    console.log(
      `${r.verdict.padEnd(5)} n=${r.n} ρ=${r.rho?.toFixed(2) ?? "—"} | ${r.ind} | #1 ${r.champ}(${(r.champRet * 100).toFixed(1)}%) 3y#1 ${r.ret1}(${(r.ret1ret * 100).toFixed(1)}%)`,
    );
  }
  return miss && !rows.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
