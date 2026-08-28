#!/usr/bin/env node
/**
 * 桌面终报骨架：读 Step2 事实卡 JSON，写目录 ~/Desktop/buffett-YYYYMMDDHHmm/
 *
 * 分册（避免单文件过长）：
 *   00-总览.md     — 今日建仓建议 + 分册目录
 *   1x–7x-*.md    — 按生意形态 fin_kind 分册；册内仍按东财三级行业分组
 *   99-硬筛剔除.md
 *
 * 「巴菲特交叉验证」「主要风险」留空位，由 Agent 按 Buffett 视角逐票现写。
 *
 * 用法:
 *   node gen_buffett_report.js
 *   node gen_buffett_report.js --facts ~/Desktop/temp/buffett_step2_facts.json --step1 ~/Desktop/temp/buffett_step1.json
 *   node gen_buffett_report.js --out-dir ~/Desktop/buffett-自定义
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { industryDisplayKey } from "./industry_map.js";
import { buffettTmp, buffettTmpDir, parseArgs, readJsonFile } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(x, nd = 2) {
  if (x == null) return "—";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : x.toFixed(nd);
  return String(x);
}

function fmtYi(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function cardKind(card) {
  return card?.fin_kind || card?.special?.kind || "corp";
}

function taxDiv(div) {
  if (div == null) return "—";
  return `TTM ${div}%｜持股>1年免税；≤1年税后约 ${(div * 0.9).toFixed(2)}% / ${(div * 0.8).toFixed(2)}%`;
}

function isForwardAdjustedKline(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return payload.fqt === 1 || payload.adjust === "forward" || payload.adj === "forward";
}

function resolveTechKlinePath(tmpDir, code, period) {
  const qfqPath = path.join(tmpDir, `${code}_${period}_qfq.json`);
  if (fs.existsSync(qfqPath)) return qfqPath;

  const legacyPath = path.join(tmpDir, `${code}_${period}.json`);
  if (!fs.existsSync(legacyPath)) return null;
  try {
    const legacy = readJsonFile(legacyPath);
    return isForwardAdjustedKline(legacy) ? legacyPath : null;
  } catch {
    return null;
  }
}

function loadBoll(tmpDir, code) {
  const result = { D: null, W: null, M: null };
  for (const [p, key] of [
    ["day", "D"],
    ["week", "W"],
    ["month", "M"],
  ]) {
    const klinePath = resolveTechKlinePath(tmpDir, code, p);
    if (!klinePath) continue;
    try {
      const out = execFileSync("node", [path.join(HERE, "calc_bollinger.js"), klinePath], {
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      result[key] = parsed.bands?.[key] || null;
    } catch {
      const bollCandidates = [
        path.join(tmpDir, `${code}_${p}_qfq_boll.json`),
        path.join(tmpDir, `${code}_${p}_boll.json`),
      ];
      const bollPath = bollCandidates.find((p0) => fs.existsSync(p0));
      if (bollPath) {
        const parsed = JSON.parse(fs.readFileSync(bollPath, "utf8"));
        result[key] = parsed.bands?.[key] || null;
      }
    }
  }
  return result;
}

/** 相对半带宽：-1=下轨，0=中轨，+1=上轨。跌破下轨 < -1，升破上轨 > 1。 */
function bandRelFromMid(b) {
  const close = b?.close;
  const mid = b?.mid;
  const upper = b?.upper;
  const lower = b?.lower;
  if (![close, mid, upper, lower].every(Number.isFinite)) return null;
  if (close >= mid) {
    const half = upper - mid;
    if (!(half > 0)) return close > mid ? Infinity : 0;
    return (close - mid) / half;
  }
  const half = mid - lower;
  if (!(half > 0)) return close < mid ? -Infinity : 0;
  return (close - mid) / half;
}

/** 所有边界松弛统一为相对参考价 ≤5%（不再用半带宽 1/4）。 */
const PRICE_SLACK = 0.05;

function pricePctFrom(close, ref) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return null;
  return (close - ref) / ref;
}

/** ≤ 轨，或最多高出参考价 PRICE_SLACK。 */
function isAtOrWithinAbove(close, ref, slack = PRICE_SLACK) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return false;
  if (close <= ref) return true;
  return (close - ref) / ref <= slack;
}

/** ≥ 轨，或最多低于参考价 PRICE_SLACK。 */
function isAtOrWithinBelow(close, ref, slack = PRICE_SLACK) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return false;
  if (close >= ref) return true;
  return (ref - close) / ref <= slack;
}

/** 周线下轨附近：≤下轨，或相对下轨价高出 ≤5%。 */
function isWeekNearLow(bW) {
  return isAtOrWithinAbove(bW?.close, bW?.lower);
}

/**
 * 月线中轨～下轨：落在 [下轨×(1−5%), 中轨×(1+5%)]。
 */
function isMonthMidToLow(bM) {
  const close = bM?.close;
  const mid = bM?.mid;
  const lower = bM?.lower;
  if (![close, mid, lower].every(Number.isFinite) || !(mid > 0) || !(lower > 0)) return false;
  return isAtOrWithinAbove(close, mid) && isAtOrWithinBelow(close, lower);
}

function zoneLabel(b) {
  if (!b?.ok) return b?.error || "无法计算";
  const pos = bandRelFromMid(b);
  if (isWeekNearLow(b) || (Number.isFinite(b.close) && Number.isFinite(b.lower) && b.close <= b.lower)) {
    return "下轨附近";
  }
  if (b.close >= b.upper) return "上轨附近";
  if (isMonthMidToLow(b) && pos != null && pos <= PRICE_SLACK) return "中～下轨";
  if (pos != null && pos <= 0) return "中～下轨";
  if (isAtOrWithinAbove(b.close, b.mid) && pos > 0) return "中轨附近（略上≤5%）";
  if (b.close > b.mid && b.close < b.upper) return "中～上轨";
  return "中轨附近";
}

/** 周下 + 月中～月下（边界一律股价 5%）。日线不进建仓门槛。不做带宽/PE/PB 闸门。 */
function bollSignal(bD, bW, bM) {
  if (!bW?.ok || !bM?.ok) {
    return { signal: "K线不足，观望", batchOk: false, weekResonance: false };
  }
  const weekNearLow = isWeekNearLow(bW);
  const monthMidLow = isMonthMidToLow(bM);
  if (weekNearLow && monthMidLow) {
    return {
      signal: "可尝试批量建仓（周下+月中～下）",
      batchOk: true,
      weekResonance: true,
    };
  }
  if (!weekNearLow) return { signal: "周线未到下轨附近", batchOk: false, weekResonance: false };
  if (!monthMidLow) {
    const aboveMid = Number.isFinite(bM.close) && Number.isFinite(bM.mid) && bM.close > bM.mid * (1 + PRICE_SLACK);
    return {
      signal: aboveMid ? "月线高于中轨（>5%），未到买点" : "月线未落在中～下轨（边界5%）",
      batchOk: false,
      weekResonance: true,
    };
  }
  return { signal: "观望", batchOk: false, weekResonance: false };
}

function techBlock(boll) {
  const fmtB = (b, name) => {
    if (!b?.ok) return `${name}：${b?.error || "无法计算"}`;
    return `${name}：收盘(前复权)${b.close}｜中轨${b.mid}｜上${b.upper}｜下${b.lower}｜带宽${b.bandwidth_pct}%｜${zoneLabel(b)}`;
  };
  const sig = bollSignal(boll.D, boll.W, boll.M);
  const near = boll.W?.mid;
  const opt =
    boll.W?.upper != null && boll.M?.upper != null
      ? Math.min(boll.W.upper, boll.M.upper)
      : boll.W?.upper ?? boll.M?.upper;
  const text = [
    fmtB(boll.D, "日线"),
    fmtB(boll.W, "周线"),
    fmtB(boll.M, "月线"),
    `信号来源：布林带｜结论：${sig.signal}`,
    `K 线来源：前复权（*_qfq / fqt=1；收益观察用 *_hfq 后复权，不进买卖），as_of=${boll.D?.as_of || "—"}`,
    near != null
      ? `技术目标（前复权轨）：近端=周中轨 ${near}；乐观=周/月上轨更保守者 ${fmt(opt)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, sig };
}

function hasHardRed(card) {
  return Array.isArray(card.red_hints) && card.red_hints.length > 0;
}

function industryGroupKey(card) {
  return industryDisplayKey(card);
}

/** 写入今日建仓建议：布林到位 + 无 hard 红线。 */
function canSuggestToday(card, sig) {
  if (!sig?.batchOk) return false;
  if (hasHardRed(card)) return false;
  return true;
}

function rankTodayBuys(a, b) {
  return (
    Number(b.sig.weekResonance) - Number(a.sig.weekResonance) ||
    (b.c.bond_ratio || 0) - (a.c.bond_ratio || 0) ||
    String(a.c.code).localeCompare(String(b.c.code))
  );
}

function actionBlock(card, sig, { inToday } = {}) {
  if (inToday) {
    return "建仓建议（布林到位：周下+月中～下）";
  }
  if (sig.batchOk && hasHardRed(card)) {
    return `观望：布林到位，hard红线不入今日建议：${card.red_hints.join("；")}。`;
  }
  if (hasHardRed(card)) return `观望：${sig.signal}。hard红线：${card.red_hints.join("；")}。`;
  return `观望：${sig.signal}`;
}

function redReview(card) {
  const hard = card.red_hints || [];
  const soft = card.soft_hints || [];
  if (!hard.length && !soft.length) return "无 hard/soft 提示；复核通过。";
  return `hard=${hard.join("；") || "无"}；soft=${soft.join("；") || "无"}。Agent 复核 hard 提示后定终评。`;
}

function factsSummary(c) {
  const lines = [];
  lines.push(
    `- 派息 ${fmt(c.pay_ratio)}%（${c.pay_ratio_source || "无来源"}${c.pay_ratio_year ? `，${c.pay_ratio_year}` : ""}）｜ROE3 ${fmt(c.roe3)}%｜负债率 ${fmt(c.debt)}%`,
  );
  if ((c.fcf_cov || []).length) {
    const recent = c.fcf_cov
      .slice(0, 3)
      .map((r) => `${r.year || "?"}覆盖${fmt(r.cover)}`)
      .join(" / ");
    lines.push(`- FCF/分红覆盖（近）：${recent}`);
  }
  if (c.special?.kind && c.special.kind !== "corp") {
    lines.push(`- 专项 kind=${c.special.kind}（见事实卡；银/保/证勿套工业 FCF）`);
  }
  if ((c.data_gaps || []).length) {
    lines.push(`- 缺口：${c.data_gaps.join("；")}`);
  }
  return lines.join("\n");
}

/** 分册顺序：金融 → 公用/基建 → 周期 → 制造/消费 → 科技；未列 kind 归「其他」。 */
const KIND_VOLUMES = [
  { kind: "bank", file: "10-银行.md", title: "银行" },
  { kind: "insurance", file: "11-保险.md", title: "保险" },
  { kind: "broker", file: "12-证券.md", title: "证券" },
  { kind: "utility", file: "20-公用事业.md", title: "公用事业" },
  { kind: "infra_construction", file: "21-基建建设.md", title: "基建建设" },
  { kind: "resource_cycle", file: "30-资源周期.md", title: "资源周期" },
  { kind: "equip_mfg", file: "40-装备制造.md", title: "装备制造" },
  { kind: "appliance", file: "50-家电.md", title: "家电" },
  { kind: "brand_consumer", file: "60-品牌消费.md", title: "品牌消费" },
  { kind: "tech_hardware", file: "70-科技硬件.md", title: "科技硬件" },
  { kind: "corp", file: "80-其他.md", title: "其他（corp 兜底）" },
];

function kindVolumeMeta(kind) {
  return KIND_VOLUMES.find((v) => v.kind === kind) || KIND_VOLUMES[KIND_VOLUMES.length - 1];
}

function safeFileStem(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}

function groupByIndustrySorted(cardList) {
  function sortCards(a, b) {
    return (
      (b.bond_ratio || 0) - (a.bond_ratio || 0) ||
      (b.div || 0) - (a.div || 0) ||
      String(a.code).localeCompare(String(b.code))
    );
  }
  const byIndustry = new Map();
  for (const c of cardList) {
    const key = industryGroupKey(c);
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key).push(c);
  }
  for (const list of byIndustry.values()) list.sort(sortCards);
  return [...byIndustry.entries()].sort((a, b) => {
    const maxA = a[1][0]?.bond_ratio ?? -1;
    const maxB = b[1][0]?.bond_ratio ?? -1;
    return maxB - maxA || a[0].localeCompare(b[0], "zh");
  });
}

function renderStockCard(c, { bollCache, todayCodes, fiveByCode }) {
  const L = [];
  L.push(`#### ${c.code} ${c.name}`);
  L.push("");
  L.push(
    `**基础信息**：市值 ${fmtYi(c.mkt_yi)} 亿；东财 f100=${c.f100}${c.industry_f10?.l3 ? `；三级=${c.industry_f10.l3}` : ""}；现价 ${c.price}；${taxDiv(c.div)}；股息/国债比 ${fmt(c.bond_ratio, 2)}；连续现金分红 ${c.div_streak} 年。`,
  );
  L.push("");
  L.push("**关键财务摘要**：");
  L.push(factsSummary(c));
  L.push("");
  L.push("**经营壁垒备注**：（可选；仅核实事实）");
  L.push("");
  L.push(`**红线**：${redReview(c)}`);
  L.push("");
  const boll = bollCache[c.code] || { D: null, W: null, M: null };
  const { text: techText, sig } = techBlock(boll);
  L.push("**技术位**：");
  L.push(techText);
  L.push("");
  L.push(`**预期目标价**：${boll.D?.ok ? "见技术位（操作采用技术档）" : "—"}`);
  L.push("");
  L.push(`**操作**：${actionBlock(c, sig, { inToday: todayCodes.has(c.code) })}`);
  L.push("");
  if (todayCodes.has(c.code)) {
    const five = fiveByCode?.get(c.code);
    L.push("**五维估值（Step3，仅建仓建议票）**：");
    if (!five) {
      L.push("未跑或失败；见 [02-五维估值.md](02-五维估值.md)。");
    } else if (!five.ok) {
      L.push(`失败：${five.error || "—"}`);
    } else {
      const d = five.five_dim.dims;
      const fp = (x) => (x == null ? "—" : Number(x).toFixed(1));
      L.push(
        `总分 **${five.five_dim.total}**｜PE分位 ${fp(d.pe.pct)}｜PB分位 ${fp(d.pb.pct)}｜ERP分位 ${fp(d.erp.pct)}｜DRP分位 ${fp(d.drp.pct)}｜现价分位 ${fp(d.price.pct)}`,
      );
      L.push("详见 [02-五维估值.md](02-五维估值.md)。");
    }
    L.push("");
  }
  L.push("**巴菲特交叉验证**：（Agent 按 Buffett 视角现写，2–4 句）");
  L.push("");
  L.push("**主要风险**：（Agent 现写 1–3 条，须对本票特异）");
  L.push("");
  return L;
}

function runFiveDimForBuys(todayBuys, { factsPath, bondPath, outJson, outMd }) {
  if (!todayBuys.length) {
    return { results: [], byCode: new Map() };
  }
  const buysPath = buffettTmp("buffett_today_buys.json");
  const buysPayload = {
    generated_at: new Date().toISOString(),
    buys: todayBuys.map(({ c }) => ({
      code: c.code,
      name: c.name,
      market: c.market,
      div: c.div,
      pay_hist: c.pay_hist || [],
    })),
  };
  fs.writeFileSync(buysPath, `${JSON.stringify(buysPayload, null, 2)}\n`, "utf8");
  try {
    execFileSync(
      "node",
      [
        path.join(HERE, "calc_buy_five_dim.js"),
        "--buys",
        buysPath,
        "--facts",
        factsPath,
        "--bond",
        bondPath,
        "-o",
        outJson,
        "--md",
        outMd,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (exc) {
    const msg = String(exc.stderr || exc.stdout || exc.message || exc).slice(0, 800);
    console.error(`five-dim failed: ${msg}`);
    return { results: [], byCode: new Map(), error: msg };
  }
  try {
    const payload = readJsonFile(outJson);
    const results = payload.results || [];
    return { results, byCode: new Map(results.map((r) => [String(r.code), r])), payload };
  } catch (exc) {
    return { results: [], byCode: new Map(), error: String(exc.message || exc) };
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      facts: buffettTmp("buffett_step2_facts.json"),
      step1: buffettTmp("buffett_step1.json"),
      xuangu: buffettTmp("buffett_xuangu_result.json"),
      tmp: buffettTmpDir(),
    },
  });

  const data = readJsonFile(args.facts);
  const step1 = readJsonFile(args.step1);
  const xuangu = fs.existsSync(args.xuangu) ? readJsonFile(args.xuangu) : { source: "—" };
  const cards = [...(data.cards || [])];

  const bollCache = {};
  const sigCache = {};
  for (const c of cards) {
    const boll = loadBoll(args.tmp, c.code);
    bollCache[c.code] = boll;
    sigCache[c.code] = bollSignal(boll.D, boll.W, boll.M);
  }

  const todayBuys = cards
    .filter((c) => canSuggestToday(c, sigCache[c.code]))
    .map((c) => ({ c, sig: sigCache[c.code], boll: bollCache[c.code] }))
    .sort(rankTodayBuys);

  const todayCodes = new Set(todayBuys.map(({ c }) => c.code));

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const outDir =
    args["out-dir"] ||
    args.output ||
    path.join(process.env.HOME, "Desktop", `buffett-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const K = todayBuys.length;

  const fiveJson = path.join(outDir, "buffett_five_dim.json");
  const fiveMd = path.join(outDir, "02-五维估值.md");
  let bondPath = buffettTmp("buffett_bond.json");
  if (!fs.existsSync(bondPath) && data.bond?.yield_pct != null) {
    fs.writeFileSync(bondPath, `${JSON.stringify(data.bond, null, 2)}\n`, "utf8");
  }
  if (!fs.existsSync(bondPath)) {
    bondPath = path.join(outDir, "_bond_from_facts.json");
    fs.writeFileSync(bondPath, `${JSON.stringify(data.bond || {}, null, 2)}\n`, "utf8");
  }
  console.log(`Step3 five-dim for K=${K} …`);
  const five = runFiveDimForBuys(todayBuys, {
    factsPath: args.facts,
    bondPath,
    outJson: fiveJson,
    outMd: fiveMd,
  });
  if (five.error && K > 0) {
    fs.writeFileSync(
      fiveMd,
      `# 今日建仓 · 五维估值\n\n运行失败：${five.error}\n`,
      "utf8",
    );
  } else if (K === 0) {
    fs.writeFileSync(
      fiveMd,
      "# 今日建仓 · 五维估值\n\n今日无建仓建议，跳过五维估值。\n",
      "utf8",
    );
  }

  const byKind = new Map();
  for (const c of cards) {
    const kind = cardKind(c);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(c);
  }

  const volumeRows = [];
  for (const vol of KIND_VOLUMES) {
    const list = byKind.get(vol.kind) || [];
    if (!list.length) continue;
    const industryGroups = groupByIndustrySorted(list);
    const buysInVol = todayBuys.filter(({ c }) => cardKind(c) === vol.kind).length;
    volumeRows.push({
      ...vol,
      n: list.length,
      buys: buysInVol,
      industryGroups,
      list,
    });
  }
  for (const [kind, list] of byKind) {
    if (KIND_VOLUMES.some((v) => v.kind === kind)) continue;
    if (!list.length) continue;
    const meta = kindVolumeMeta(kind);
    const file = `${meta.file.replace(/\.md$/, "")}-${safeFileStem(kind)}.md`;
    volumeRows.push({
      kind,
      file,
      title: `${meta.title}·${kind}`,
      n: list.length,
      buys: todayBuys.filter(({ c }) => cardKind(c) === kind).length,
      industryGroups: groupByIndustrySorted(list),
      list,
    });
  }

  const codeToVolFile = new Map();
  for (const vol of volumeRows) {
    for (const c of vol.list) codeToVolFile.set(c.code, vol.file);
  }

  // —— 00 总览 ——
  const overview = [];
  overview.push("# A股高股息长线复利 · 今日总览");
  overview.push("");
  overview.push(`生成时点：${now.toISOString()}｜研究框架，不构成投资建议。`);
  overview.push(
    `国债10Y：${data.bond.yield_pct}%（${data.bond.source}，${data.bond.fetched_at}）｜股息门槛：≥国债×2 = ${(data.bond.yield_pct * 2).toFixed(2)}%`,
  );
  overview.push(
    `候选池：N=${step1.n_pool}（${xuangu.source || "xuangu-result-dom"}）→ 硬筛通过 M=${step1.n_pass} → 今日建仓建议 K=${K}`,
  );
  overview.push("");
  overview.push(
    "本套报告按**生意形态模板**拆成多册（册内仍按东财三级行业分组）。每票只写一份完整分析，不另开短评/详报两套。不做质地评分排名。",
  );
  overview.push("");
  overview.push(`## 1. 今日建仓建议一览（K=${K}）`);
  overview.push("");
  overview.push(
    "条件：「布林到位 + 无 hard 红线」——允许 K=0。",
  );
  overview.push("");
  if (K === 0) {
    overview.push(
      "**今日无建仓建议**：无票同时满足「周线下轨附近 + 月线中～下轨（边界均≤股价5%）+ 无 hard 红线」。",
    );
    overview.push("");
  }
  overview.push("| 代码 | 简称 | 现价 | TTM股息率 | 五维总分 | 分册 |");
  overview.push("|---|---|---|---|---:|---|");
  if (K === 0) {
    overview.push("| — | — | — | — | — | 今日无建仓建议 |");
  } else {
    for (const { c } of todayBuys) {
      const volFile = codeToVolFile.get(c.code) || "—";
      const f = five.byCode.get(c.code);
      const total = f?.ok ? f.five_dim.total : "—";
      overview.push(
        `| ${c.code} | ${c.name} | ${c.price} | ${c.div}% | ${total} | [${volFile}](${volFile}) |`,
      );
    }
  }
  overview.push("");
  overview.push("五维明细见 [02-五维估值.md](02-五维估值.md)。建仓条件仍是布林+无 hard；五维只作解释/排序参考。");
  overview.push("");
  overview.push("## 2. 分册目录");
  overview.push("");
  overview.push("| 分册 | 模板 | 只数 | 今日建仓 |");
  overview.push("|---|---|---:|---:|");
  for (const vol of volumeRows) {
    overview.push(`| [${vol.file}](${vol.file}) | ${vol.title}（\`${vol.kind}\`） | ${vol.n} | ${vol.buys} |`);
  }
  overview.push(`| [02-五维估值.md](02-五维估值.md) | 建仓票五维分位 | ${K} | — |`);
  overview.push(`| [99-硬筛剔除.md](99-硬筛剔除.md) | 硬门槛未过 | ${step1.n_reject ?? (step1.reject || []).length} | — |`);
  overview.push("");
  overview.push("阅读建议：先看本总览建仓表 → 五维估值 → 点开对应分册核对事实/技术位/巴菲特交叉验证。");
  overview.push("");
  fs.writeFileSync(path.join(outDir, "00-总览.md"), overview.join("\n"), "utf8");

  // —— 分册 ——
  for (const vol of volumeRows) {
    const L = [];
    L.push(`# ${vol.title}（${vol.n} 只｜模板 \`${vol.kind}\`）`);
    L.push("");
    L.push(`← [${"00-总览.md"}](00-总览.md)｜生成时点 ${now.toISOString()}`);
    L.push("");
    L.push(
      "按东财 F10 三级行业分组（无 l3 则回退 f100）；组内按股息/国债比降序。",
    );
    L.push("");
    L.push("| 行业 | 只数 |");
    L.push("|---|---|");
    for (const [ind, list] of vol.industryGroups) {
      L.push(`| ${ind} | ${list.length} |`);
    }
    L.push("");
    for (const [ind, list] of vol.industryGroups) {
      L.push(`### ${ind}（${list.length} 只）`);
      L.push("");
      for (const c of list) {
        L.push(...renderStockCard(c, { bollCache, todayCodes, fiveByCode: five.byCode }));
      }
    }
    fs.writeFileSync(path.join(outDir, vol.file), L.join("\n"), "utf8");
  }

  // —— 99 剔除 ——
  const rej = [];
  rej.push("# 硬门槛剔除简表");
  rej.push("");
  rej.push(`← [00-总览.md](00-总览.md)｜生成时点 ${now.toISOString()}`);
  rej.push("");
  rej.push("| 代码 | 简称 | 原因 |");
  rej.push("|---|---|---|");
  for (const r of step1.reject || []) {
    rej.push(`| ${r.code} | ${r.name} | ${(r.reject_reasons || []).join("；") || "股息缺失"} |`);
  }
  rej.push("");
  fs.writeFileSync(path.join(outDir, "99-硬筛剔除.md"), rej.join("\n"), "utf8");

  console.log(`REPORT_DIR=${outDir}`);
  console.log(`REPORT=${path.join(outDir, "00-总览.md")}`);
  console.log(`K=${K}`);
  console.log(`VOLUMES=${volumeRows.map((v) => v.file).join(",")}`);
  return 0;
}

export {
  PRICE_SLACK,
  KIND_VOLUMES,
  bandRelFromMid,
  bollSignal,
  canSuggestToday,
  isAtOrWithinAbove,
  isAtOrWithinBelow,
  isMonthMidToLow,
  isWeekNearLow,
  main,
  pricePctFrom,
  zoneLabel,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
