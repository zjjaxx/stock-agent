/**
 * 同行组内：当下评分 vs 近 N 月后复权月线收益（回测/校准；不进买卖）。
 * 只读 `{code}_month_hfq.json`。
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./opencli_json.js";
import { peerMeta } from "./industry_map.js";

export function industryDisplayKey(card) {
  const m = peerMeta(card);
  if (!m.label) return "未知行业";
  if (m.source === "l3" && m.f100 && m.f100 !== m.label) {
    return `${m.label}（f100=${m.f100}）`;
  }
  return m.label;
}

export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const rank = (arr) => {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = Array(arr.length);
    for (let i = 0; i < sorted.length; i++) out[sorted[i].i] = i + 1;
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
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

export function monthRetHfq(tmpDir, code, months) {
  const p = path.join(tmpDir, `${code}_month_hfq.json`);
  if (!fs.existsSync(p)) return { ok: false, reason: "missing_hfq" };
  const j = readJsonFile(p);
  if (j.adjust && j.adjust !== "backward" && j.fqt !== 2) {
    return { ok: false, reason: `not_hfq:${j.adjust || j.fqt}` };
  }
  const bars = j.bars || [];
  if (bars.length < months + 1) {
    return { ok: false, reason: `short:${bars.length}`, n: bars.length };
  }
  const a = bars[bars.length - 1 - months];
  const b = bars[bars.length - 1];
  if (!(a?.close > 0) || !(b?.close > 0)) return { ok: false, reason: "bad_close" };
  return {
    ok: true,
    from: a.date,
    to: b.date,
    ret: b.close / a.close - 1,
    n: bars.length,
  };
}

function pct(ret) {
  if (ret == null || !Number.isFinite(ret)) return "—";
  return `${(ret * 100).toFixed(1)}%`;
}

function verdictLabel(v) {
  if (v === "exact") return "一致（评分第1=收益第1）";
  if (v === "soft") return "接近（评分第1=收益第2）";
  if (v === "miss") return "偏离（评分第1非收益前2）";
  if (v === "solo") return "单票（n=1，无组内对照）";
  return "—";
}

/**
 * @param {object[]} cards
 * @param {string} tmpDir
 * @param {{ months?: number, groupKey?: (c: object) => string }} opts
 * @returns {Map<string, object>}
 */
export function buildIndustryBacktest(cards, tmpDir, { months = 36, groupKey = industryDisplayKey } = {}) {
  const byInd = new Map();
  for (const c of cards || []) {
    const r = monthRetHfq(tmpDir, c.code, months);
    const key = groupKey(c);
    if (!byInd.has(key)) {
      byInd.set(key, { key, members: [], missing: [] });
    }
    const bucket = byInd.get(key);
    if (!r.ok) {
      bucket.missing.push({ code: c.code, name: c.name, reason: r.reason });
      continue;
    }
    bucket.members.push({
      code: c.code,
      name: c.name,
      rank: c.score?.rank,
      total: c.score?.total,
      ret: r.ret,
      from: r.from,
      to: r.to,
    });
  }

  for (const bucket of byInd.values()) {
    const list = bucket.members;
    bucket.months = months;
    bucket.from = list[0]?.from;
    bucket.to = list[0]?.to;
    if (list.length === 0) {
      bucket.verdict = "nodata";
      continue;
    }
    if (list.length === 1) {
      bucket.verdict = "solo";
      bucket.solo = list[0];
      continue;
    }
    const rho = spearman(
      list.map((x) => x.total),
      list.map((x) => x.ret),
    );
    const byScore = [...list].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const byRet = [...list].sort((a, b) => b.ret - a.ret);
    const champ = byScore[0];
    const ret1 = byRet[0];
    const champRetRank = byRet.findIndex((x) => x.code === champ.code) + 1;
    const verdict = champRetRank === 1 ? "exact" : champRetRank === 2 ? "soft" : "miss";
    const retRankByCode = new Map(byRet.map((x, i) => [x.code, i + 1]));
    bucket.rho = rho;
    bucket.verdict = verdict;
    bucket.champ = champ;
    bucket.ret1 = ret1;
    bucket.champRetRank = champRetRank;
    bucket.byScore = byScore.map((x) => ({ ...x, retRank: retRankByCode.get(x.code) }));
  }
  return byInd;
}

/** 行业明细 Markdown 块（n≥2 含 ρ 与 verdict；n=1 只列单票收益）。 */
export function renderIndustryBacktestBlock(bt, { months = 36 } = {}) {
  if (!bt) return [];
  const L = [];
  L.push(`**回测（近${months}月后复权）**：`);
  if (bt.verdict === "nodata") {
    L.push("无可用后复权月线；跳过组内对照。");
    if (bt.missing?.length) {
      L.push(`缺 K 线：${bt.missing.map((x) => x.code).join("、")}。`);
    }
    L.push("");
    return L;
  }
  if (bt.verdict === "solo") {
    L.push(
      `单票 n=1；${bt.solo.code} ${bt.solo.name} 近${months}月收益 ${pct(bt.solo.ret)}（${bt.solo.from}→${bt.solo.to}）。`,
    );
    L.push("说明：组内仅 1 只，不算 Spearman。");
    L.push("");
    return L;
  }
  L.push(
    `${verdictLabel(bt.verdict)}；Spearman ρ=${bt.rho != null ? bt.rho.toFixed(2) : "—"}；` +
      `评分第1 ${bt.champ.code} ${bt.champ.name}（${pct(bt.champ.ret)}） vs 收益第1 ${bt.ret1.code} ${bt.ret1.name}（${pct(bt.ret1.ret)}）。` +
      `窗口 ${bt.from}→${bt.to}。`,
  );
  L.push("");
  L.push("| 代码 | 简称 | 评分名次 | 总分 | 近" + months + "月收益 | 收益名次 |");
  L.push("|---|---|---|---:|---:|---:|");
  for (const x of bt.byScore) {
    L.push(
      `| ${x.code} | ${x.name} | 第${x.rank ?? "—"}/${bt.byScore.length} | ${x.total ?? "—"} | ${pct(x.ret)} | ${x.retRank ?? "—"} |`,
    );
  }
  if (bt.missing?.length) {
    L.push("");
    L.push(`缺后复权 K 线（未入表）：${bt.missing.map((x) => `${x.code}(${x.reason})`).join("、")}。`);
  }
  L.push("");
  L.push(
    "对照说明：收益=后复权月线收盘总回报；评分是**当下**质地分位加权，非 N 年前排名。勿与前复权布林绝对价混比。",
  );
  L.push("");
  return L;
}
