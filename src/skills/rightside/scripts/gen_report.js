#!/usr/bin/env node
/**
 * 桌面终报骨架：读 Step1 行业标注池，写目录 ~/Desktop/rightside-YYYYMMDDHHmm/
 *
 * 分册（避免单文件过长）：
 *   00-总览.md     — 大盘/行业上下文 + 今日建仓建议 + 分册目录
 *   1x–8x-*.md    — 按生意形态 fin_kind 分册；册内按东财 f100 分组
 *
 * 「主要风险」留空位，由 Agent 逐票现写。技术位是笑傲牛熊六条件清单（见 calc_stage.js），不出目标位。
 *
 * 用法:
 *   node gen_report.js
 *   node gen_report.js --pool ~/Desktop/temp/rightside_pass_pool.json
 *   node gen_report.js --out-dir ~/Desktop/rightside-自定义
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGE_PLAYBOOK } from "./calc_stage.js";
import { finKindFromF100, industryDisplayKey } from "./industry_map.js";
import { tmpPath, tmpDir, parseArgs, readJsonFile } from "./opencli_json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtYi(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function cardKind(card) {
  return card?.fin_kind || "corp";
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

/** 技术位（六条件清单）：优先读缓存 {code}_stage.json，缺失则现算日线前复权。 */
function loadStage(tmpDir, code, industry) {
  const cached = path.join(tmpDir, `${code}_stage.json`);
  if (fs.existsSync(cached)) {
    try {
      return readJsonFile(cached);
    } catch {
      /* 落盘损坏则现算 */
    }
  }
  const klinePath = resolveTechKlinePath(tmpDir, code, "day");
  if (!klinePath) return { ok: false, error: "日线前复权 K 线未落盘" };
  try {
    const argv = [
      path.join(HERE, "calc_stage.js"),
      klinePath,
      "--context",
      path.join(tmpDir, "rightside_market_context.json"),
    ];
    if (industry) argv.push("--industry", industry);
    return JSON.parse(execFileSync("node", argv, { encoding: "utf8" }));
  } catch (exc) {
    return { ok: false, error: String(exc.message || exc).slice(0, 200) };
  }
}

/** 条件6 前置 + 3+4 突破 或 5 回踩 才给建仓建议；条件1/2 大盘与行业仅作参考。 */
function stageSignal(stage) {
  if (!stage?.ok) {
    return {
      stage: null,
      signal: `技术位无法判定：${stage?.error || "缺 K 线"}`,
      buyOk: false,
    };
  }
  const label = `${stage.stage_label}${stage.entry_kind ? `（${stage.entry_kind}）` : ""}`;
  return {
    stage: stage.stage,
    entryKind: stage.entry_kind,
    passed: stage.checks_passed,
    label,
    reason: stage.action_reason,
    signal: `${label}｜${stage.action}：${stage.action_reason}`,
    buyOk: stage.action === "建仓建议",
  };
}

function checkMark(c) {
  if (c.forbid) return "禁买";
  if (c.unknown) return c.advisory ? "未知（参考）" : "未知";
  const mark = c.pass ? "✓" : "✗";
  return c.advisory ? `${mark}（参考）` : mark;
}

function techBlock(stage) {
  const sig = stageSignal(stage);
  if (!stage?.ok) {
    return {
      text: `**技术位 · 笑傲牛熊六条件**：${stage?.error || "缺日线前复权 K 线"}（无法给操作，观望）`,
      sig,
    };
  }
  const m = stage.metrics;
  const text = [
    `**技术位 · 笑傲牛熊六条件**（通过 ${stage.checks_passed}/6；6 为前置，3+4 构成突破买点，5 构成回踩买点；1/2 大盘与行业仅作参考不否决）：`,
    "",
    "| # | 条件 | 结论 | 依据 |",
    "|---|---|:--:|---|",
    ...stage.checks.map((c) => `| ${c.id} | ${c.name} | ${checkMark(c)} | ${c.detail} |`),
    "",
    ...(stage.market_warning ? [`> ⚠️ ${stage.market_warning}`, ""] : []),
    ...(stage.industry_warning ? [`> ⚠️ ${stage.industry_warning}`, ""] : []),
    `**所处阶段**：${stage.stage_label}（30 周均线 ${m.ma30w}，近 5 周${m.slope_word} ${m.slope_pct}%；现价距均线 ${m.dev_pct}%）`,
    `关键价位：阻力区上沿 ${m.base_high}／下沿 ${m.base_low}｜52 周高 ${m.high52w}／低 ${m.low52w}｜上方阻力占比 ${m.overhead_pct}%`,
    `K 线来源：日线前复权重采样周线（*_qfq / fqt=1，共 ${stage.weeks} 根周 bar；*_hfq 后复权只作收益观察），as_of=${stage.as_of}`,
    "",
    `**本阶段策略**：${stage.strategy}`,
    `**触发价**：放量站上 ${stage.trigger_price}（量能须达近 26 周均量 2 倍）`,
    `**离场/风控**：${stage.exit_signals.join("；")}`,
  ].join("\n");
  return { text, sig };
}

function industryGroupKey(card) {
  return industryDisplayKey(card);
}

/** 写入今日建仓建议：六条件放行才算。 */
function canSuggestToday(_card, sig) {
  return Boolean(sig?.buyOk);
}

/** 突破买点排前，其次回踩；同类按代码，避免任何基本面指标混进排序。 */
function rankTodayBuys(a, b) {
  const subRank = (s) => (s?.entryKind === "突破买点" ? 2 : s?.entryKind === "回踩买点" ? 1 : 0);
  return subRank(b.sig) - subRank(a.sig) || String(a.c.code).localeCompare(String(b.c.code));
}

function actionBlock(card, sig, { inToday } = {}) {
  if (inToday) return `建仓建议 · ${sig.label}——${sig.reason}`;
  return `观望 · ${sig.label || "阶段未知"}——${sig.reason || sig.signal}`;
}

function loadPool(poolPath) {
  const data = readJsonFile(poolPath);
  const rows = Array.isArray(data) ? data : data?.pool;
  if (!Array.isArray(rows)) throw new Error('池文件须为数组，或 {"pool": [...]}');
  return rows.map((row) => ({
    ...row,
    fin_kind: finKindFromF100(row.f100),
  }));
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

/**
 * 册内排序只按技术位强弱：建仓票 → 阶段2 → 其它，同档按代码。
 * 右侧交易没有基本面排序键，禁止把市值/估值当排序依据。
 */
function groupByIndustrySorted(cardList, sigCache) {
  const rank = (c) => {
    const sig = sigCache[c.code];
    if (sig?.buyOk) return 3;
    if (sig?.stage === 2) return 2;
    if (sig?.stage != null) return 1;
    return 0;
  };
  function sortCards(a, b) {
    return rank(b) - rank(a) || String(a.code).localeCompare(String(b.code));
  }
  const byIndustry = new Map();
  for (const c of cardList) {
    const key = industryGroupKey(c);
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key).push(c);
  }
  for (const list of byIndustry.values()) list.sort(sortCards);
  return [...byIndustry.entries()].sort((a, b) => {
    const maxA = rank(a[1][0] || {});
    const maxB = rank(b[1][0] || {});
    return maxB - maxA || a[0].localeCompare(b[0], "zh");
  });
}

function renderStockCard(c, { stageCache, todayCodes }) {
  const L = [];
  L.push(`#### ${c.code} ${c.name}`);
  L.push("");
  L.push(
    `**基础信息**：市值 ${fmtYi(c.mkt_yi)} 亿；东财 f100=${c.f100 || "—"}；现价 ${c.price ?? "—"}（选股池时点）。`,
  );
  L.push("");
  const stage = stageCache[c.code] || { ok: false, error: "未跑技术位分析" };
  const { text: techText, sig } = techBlock(stage);
  L.push(techText);
  L.push("");
  L.push(`**操作**：${actionBlock(c, sig, { inToday: todayCodes.has(c.code) })}`);
  L.push("");
  L.push("**主要风险**：（Agent 现写 1–3 条，须对本票特异）");
  L.push("");
  return L;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    defaults: {
      pool: tmpPath("rightside_pass_pool.json"),
      xuangu: tmpPath("rightside_xuangu_result.json"),
      tmp: tmpDir(),
    },
  });

  const cards = loadPool(args.pool);
  const xuangu = fs.existsSync(args.xuangu) ? readJsonFile(args.xuangu) : { source: "—" };

  const contextPath = path.join(args.tmp, "rightside_market_context.json");
  const marketCtx = fs.existsSync(contextPath) ? readJsonFile(contextPath) : null;

  const stageCache = {};
  const sigCache = {};
  for (const c of cards) {
    const stage = loadStage(args.tmp, c.code, c.f100);
    stageCache[c.code] = stage;
    sigCache[c.code] = stageSignal(stage);
  }

  const todayBuys = cards
    .filter((c) => canSuggestToday(c, sigCache[c.code]))
    .map((c) => ({ c, sig: sigCache[c.code], stage: stageCache[c.code] }))
    .sort(rankTodayBuys);

  const todayCodes = new Set(todayBuys.map(({ c }) => c.code));

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const outDir =
    args["out-dir"] ||
    args.output ||
    path.join(process.env.HOME, "Desktop", `rightside-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const K = todayBuys.length;
  const missingF100 = cards.filter((c) => !c.f100).length;

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
    volumeRows.push({
      ...vol,
      n: list.length,
      buys: todayBuys.filter(({ c }) => cardKind(c) === vol.kind).length,
      industryGroups: groupByIndustrySorted(list, sigCache),
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
      industryGroups: groupByIndustrySorted(list, sigCache),
      list,
    });
  }

  const codeToVolFile = new Map();
  for (const vol of volumeRows) {
    for (const c of vol.list) codeToVolFile.set(c.code, vol.file);
  }

  const overview = [];
  overview.push("# A股右侧交易 · 今日总览");
  overview.push("");
  overview.push(`生成时点：${now.toISOString()}｜研究框架，不构成投资建议。`);
  overview.push(
    `候选池：总市值门槛 ${xuangu.mkt_min_yi ?? "—"} 亿（${xuangu.source || "xuangu-result-dom"}）→ N=${cards.length}` +
      `（其中 f100 缺失 ${missingF100} 只，条件2 标未知参考）→ 今日建仓建议 K=${K}`,
  );
  overview.push("");
  overview.push(
    "**右侧交易**：不做基本面筛选、不看估值分位，买卖只认**笑傲牛熊六条件清单**（30 周均线 + 相对强度）。" +
      "条件1 大盘、条件2 行业仅作参考提示。报告按生意形态拆成多册（册内按东财 f100 分组），每票只写一份完整分析。",
  );
  overview.push("");
  overview.push("## 0. 大盘与行业（条件1/2 均为参考项）");
  overview.push("");
  if (!marketCtx?.market?.ok) {
    overview.push(
      "**大盘上下文缺失**：未跑 `fetch_market_context.js`，条件6 相对强度无法判定，今日不得给建仓建议。",
    );
  } else {
    const mk = marketCtx.market;
    overview.push(
      `**条件1 大盘（参考项，不否决买点）**：${mk.name} 收 ${mk.close}，${mk.above_ma ? "站上" : "跌破"} 30 周均线 ${mk.ma30w}（${mk.dev_pct}%），` +
        `均线近 5 周${mk.slope_word}（${mk.slope_pct}%）→ **${mk.pass ? "顺势环境，可正常仓位" : "逆势环境，买点仍照给，但须减小仓位、止损从严"}**`,
    );
    overview.push("");
    overview.push(
      "**条件2 行业（参考项，不否决买点）**（站上 30 周均线且均线不向下标 ✓；RS 为相对沪深300 的 Mansfield 强度；不过时买点照给但须压缩仓位）：",
    );
    overview.push("");
    overview.push("| 行业(f100) | 板块 | 距30周均线 | 均线斜率 | RS | 结论 |");
    overview.push("|---|---|---:|---:|---:|:--:|");
    for (const [name, b] of Object.entries(marketCtx.boards || {})) {
      if (!b.ok) {
        overview.push(`| ${name} | — | — | — | — | 未知 |`);
        continue;
      }
      overview.push(
        `| ${name} | ${b.board_code} | ${b.dev_pct}% | ${b.slope_pct}% | ${b.rs_vs_market?.value ?? "—"} | ${b.pass ? "✓" : "✗"} |`,
      );
    }
  }
  overview.push("");
  overview.push(`## 1. 今日建仓建议一览（K=${K}）`);
  overview.push("");
  overview.push(
    "条件：6 相对强度在零轴之上（前置），" +
      "再满足 3+4（阶段1底座上突破阻力区并放量 2 倍）或 5（阶段1→2 突破后回撤到 30 周均线且缩量）。" +
      "条件1 大盘、条件2 行业只作参考——走弱时买点照给，但结论里会带逆势/逆行业提示，需自行压缩仓位。允许 K=0。",
  );
  overview.push("");
  if (K === 0) {
    overview.push("**今日无建仓建议**：无票满足条件 6 前置 + 突破或回踩买点。");
    overview.push("");
  }
  overview.push("| 代码 | 简称 | 现价 | 市值(亿) | 买点 | 通过条件 | 触发依据 | 分册 |");
  overview.push("|---|---|---|---:|---|:--:|---|---|");
  if (K === 0) {
    overview.push("| — | — | — | — | — | — | — | 今日无建仓建议 |");
  } else {
    for (const { c, sig } of todayBuys) {
      const volFile = codeToVolFile.get(c.code) || "—";
      overview.push(
        `| ${c.code} | ${c.name} | ${c.price ?? "—"} | ${fmtYi(c.mkt_yi)} | ${sig.entryKind || "—"} | ${sig.passed}/6 | ${stageCache[c.code]?.action_reason || "—"} | [${volFile}](${volFile}) |`,
      );
    }
  }
  overview.push("");
  overview.push("## 1.1 全池阶段分布");
  overview.push("");
  overview.push("| 阶段 | 含义 | 只数 | 策略 |");
  overview.push("|---|---|---:|---|");
  for (const s of [1, 2, 3, 4]) {
    const n = cards.filter((c) => sigCache[c.code]?.stage === s).length;
    overview.push(`| 阶段${s} | ${STAGE_PLAYBOOK[s].label} | ${n} | ${STAGE_PLAYBOOK[s].strategy} |`);
  }
  const unknown = cards.filter((c) => sigCache[c.code]?.stage == null).length;
  overview.push(`| — | 技术位无法判定（K 线不足） | ${unknown} | 观望 |`);
  overview.push("");
  overview.push("## 1.2 六条件通过情况（全池）");
  overview.push("");
  overview.push("| 条件 | 通过只数 |");
  overview.push("|---|---:|");
  const checkNames = new Map();
  for (const c of cards) {
    for (const chk of stageCache[c.code]?.checks || []) {
      if (!checkNames.has(chk.id)) checkNames.set(chk.id, { name: chk.name, n: 0 });
      if (chk.pass) checkNames.get(chk.id).n += 1;
    }
  }
  for (const [id, v] of [...checkNames.entries()].sort((a, b) => a[0] - b[0])) {
    overview.push(`| ${id} ${v.name} | ${v.n} / ${cards.length} |`);
  }
  overview.push("");
  overview.push("## 2. 分册目录");
  overview.push("");
  overview.push("| 分册 | 模板 | 只数 | 今日建仓 |");
  overview.push("|---|---|---:|---:|");
  for (const vol of volumeRows) {
    overview.push(
      `| [${vol.file}](${vol.file}) | ${vol.title}（\`${vol.kind}\`） | ${vol.n} | ${vol.buys} |`,
    );
  }
  overview.push("");
  overview.push("阅读建议：先看 §0 大盘/行业顺逆环境（仅参考）→ 建仓表 → 点开对应分册核对六条件清单。");
  overview.push("");
  fs.writeFileSync(path.join(outDir, "00-总览.md"), overview.join("\n"), "utf8");

  for (const vol of volumeRows) {
    const L = [];
    L.push(`# ${vol.title}（${vol.n} 只｜模板 \`${vol.kind}\`）`);
    L.push("");
    L.push(`← [${"00-总览.md"}](00-总览.md)｜生成时点 ${now.toISOString()}`);
    L.push("");
    L.push("按东财 f100 分组；组内按技术位强弱排序（建仓票 → 阶段2 → 其它）。");
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
        L.push(...renderStockCard(c, { stageCache, todayCodes }));
      }
    }
    fs.writeFileSync(path.join(outDir, vol.file), L.join("\n"), "utf8");
  }

  console.log(`REPORT_DIR=${outDir}`);
  console.log(`REPORT=${path.join(outDir, "00-总览.md")}`);
  console.log(`K=${K}`);
  console.log(`VOLUMES=${volumeRows.map((v) => v.file).join(",")}`);
  return 0;
}

export { KIND_VOLUMES, canSuggestToday, loadStage, main, stageSignal, techBlock };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
