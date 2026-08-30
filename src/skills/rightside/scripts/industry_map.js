#!/usr/bin/env node
/**
 * 东财行业名 → fin_kind（报告分册）。
 * 只匹配行业字段（f100 / BOARD_NAME），禁止用股票简称或代码名单。
 *
 * 用法:
 *   node industry_map.js "电力"
 *   node industry_map.js --self-test
 */

import { parseArgs } from "./opencli_json.js";

/** 同行比较键：优先东财 F10 三级行业 l3，无 l3 时回退 ulist f100。禁止用股票简称。 */
export function peerMeta(card = {}) {
  const l3 = normalizeIndustry(card.industry_f10?.l3 || card.industry?.l3 || "");
  const f100 = normalizeIndustry(card.f100 || "");
  if (l3) return { key: `l3:${l3}`, label: l3, source: "l3", f100 };
  if (f100) return { key: `f100:${f100}`, label: f100, source: "f100", f100 };
  return { key: "ind:", label: "", source: null, f100: "" };
}

/** 报告分组标题：优先 l3，并在与 f100 不同时附带 f100。 */
export function industryDisplayKey(card) {
  const m = peerMeta(card);
  if (!m.label) return "未知行业";
  if (m.source === "l3" && m.f100 && m.f100 !== m.label) {
    return `${m.label}（f100=${m.f100}）`;
  }
  return m.label;
}

/**
 * 东财行业名归一：去空白 + 剥掉**词尾**的罗马数字级别后缀（`银行Ⅱ` → `银行`）。
 * 剥离必须锚定词尾：早先按字符集全局删 `IVX`，把 `IT服务Ⅱ` 削成了 `T服务`，
 * 导致该板块匹配不到 BK 代码、条件2 标「未知（参考）」。
 */
export function normalizeIndustry(raw) {
  return String(raw || "")
    .replace(/\s+/g, "")
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/, "")
    .replace(/(?:IX|IV|VI{0,3}|I{1,3}|X)$/, "")
    .trim();
}

/**
 * 生意形态种类只认东财行业字段（优先 l3，过细回退 f100）。
 * 证券/多元金融走 broker；非金按生意形态拆模板，未命中回 corp。用于报告分册。
 */
export const FIN_KINDS = [
  "bank",
  "insurance",
  "broker",
  "utility",
  "brand_consumer",
  "resource_cycle",
  "infra_construction",
  "appliance",
  "equip_mfg",
  "tech_hardware",
  "corp",
];

export function finKindFromF100(f100) {
  const key = normalizeIndustry(f100);
  if (/银行/.test(key)) return "bank";
  if (/保险/.test(key)) return "insurance";
  if (/证券|多元金融/.test(key)) return "broker";
  // 非金：utility / brand / resource / infra / appliance / equip / tech / corp
  if (/通信服务|电信|电力|水电|火电|水力|火力|核力|水务|燃气|公路|铁路|机场/.test(key) || (/港口/.test(key) && !/航运/.test(key))) {
    return "utility";
  }
  if (/白酒|饮料乳品|乳品|调味|啤酒|软饮料|食品加工|中药|家居|广告营销|一般零售/.test(key)) {
    return "brand_consumer";
  }
  if (/房屋建设|基础建设|装修装饰|工程咨询|园林工程/.test(key)) return "infra_construction";
  if (
    /煤炭|炼化|石油|石化|油气|普钢|特钢|钢铁|航运|化学原料|化学制品|农化|有色|黄金|工业金属|水泥|养殖/.test(key)
  ) {
    return "resource_cycle";
  }
  if (/白色家电|黑电|厨电|小家电/.test(key)) return "appliance";
  if (/轨交设备|工程机械|商用车|汽车零部件|专用设备|通用设备/.test(key)) return "equip_mfg";
  if (/计算机设备|通信设备|消费电子|半导体|元件|光学光电子/.test(key)) return "tech_hardware";
  return "corp";
}

/**
 * 权重模板：l3 能独立映射则用 l3（港口≠航运）；l3 过细落到 corp 时回退 f100（冰洗仍走白电）。
 */
export function finKindFromCard(card = {}) {
  const l3 = card.industry_f10?.l3 || card.industry?.l3 || "";
  const f100 = card.f100 || "";
  if (l3) {
    const fromL3 = finKindFromF100(l3);
    if (fromL3 !== "corp") return fromL3;
  }
  return finKindFromF100(f100);
}

const SELF_CASES = [
  ["银行Ⅱ", "bank", "招商银行"],
  ["保险Ⅱ", "insurance", "中国平安"],
  ["证券Ⅱ", "broker", "中信证券"],
  ["电力", "utility", "长江电力"],
  ["核力发电", "utility", "中国核电 L3"],
  ["燃气Ⅱ", "utility", "深圳燃气"],
  ["铁路公路", "utility", "宁沪高速/京沪高铁"],
  ["通信服务", "utility", "中国移动"],
  ["煤炭开采", "resource_cycle", "神华/中煤"],
  ["油气开采Ⅱ", "resource_cycle", "中国海油"],
  ["炼化及贸易", "resource_cycle", "中国石油"],
  ["普钢", "resource_cycle", "宝钢"],
  ["航运港口", "resource_cycle", "中远海控 f100"],
  ["白酒Ⅱ", "brand_consumer", "贵州茅台"],
  ["白色家电", "appliance", "格力"],
  ["房屋建设Ⅱ", "infra_construction", "中国建筑"],
  ["基础建设", "infra_construction", "中国交建"],
  ["计算机设备", "tech_hardware", "浪潮信息"],
  ["轨交设备", "equip_mfg", "中国中车"],
  ["房地产开发", "corp", "兜底"],
];

export function selfTest() {
  const fails = [];
  for (const [raw, want, note] of SELF_CASES) {
    const got = finKindFromF100(raw);
    if (got !== want) {
      fails.push(`${raw} want ${want} got ${got} (${note})`);
    }
  }
  if (finKindFromF100("银行Ⅱ") !== "bank") fails.push("fin-kind-bank");
  if (finKindFromF100("保险") !== "insurance") fails.push("fin-kind-insurance");
  if (finKindFromF100("证券") !== "broker") fails.push("fin-kind-broker");
  if (finKindFromF100("多元金融") !== "broker") fails.push("fin-kind-multi-fin");
  if (finKindFromF100("白酒Ⅱ") !== "brand_consumer") fails.push("fin-kind-brand-liquor");
  if (finKindFromF100("白色家电") !== "appliance") fails.push("fin-kind-appliance");
  if (finKindFromF100("饮料乳品") !== "brand_consumer") fails.push("fin-kind-brand-dairy");
  if (finKindFromF100("食品加工") !== "brand_consumer") fails.push("fin-kind-brand-food");
  if (finKindFromF100("电力") !== "utility") fails.push("fin-kind-utility-power");
  if (finKindFromF100("通信服务") !== "utility") fails.push("fin-kind-telecom-as-utility");
  if (finKindFromF100("煤炭开采") !== "resource_cycle") fails.push("fin-kind-resource-coal");
  if (finKindFromF100("航运港口") !== "resource_cycle") fails.push("fin-kind-resource-shipping");
  if (finKindFromF100("水泥") !== "resource_cycle") fails.push("fin-kind-resource-cement");
  if (finKindFromF100("养殖业") !== "resource_cycle") fails.push("fin-kind-resource-agri");
  if (finKindFromF100("房屋建设") !== "infra_construction") fails.push("fin-kind-infra");
  if (finKindFromF100("计算机设备") !== "tech_hardware") fails.push("fin-kind-tech");
  if (finKindFromF100("轨交设备") !== "equip_mfg") fails.push("fin-kind-equip");
  if (finKindFromF100("房地产开发") !== "corp") fails.push("fin-kind-corp-fallback");
  const portCard = { f100: "航运港口", industry_f10: { l3: "港口" } };
  const shipCard = { f100: "航运港口", industry_f10: { l3: "航运" } };
  if (finKindFromCard(portCard) !== "utility") fails.push("port-l3-utility");
  if (finKindFromCard(shipCard) !== "resource_cycle") fails.push("ship-l3-resource");
  if (peerMeta(portCard).key === peerMeta(shipCard).key) fails.push("port-ship-must-split");
  if (peerMeta(portCard).key !== "l3:港口") fails.push(`port-peer-key ${peerMeta(portCard).key}`);
  if (finKindFromCard({ f100: "白色家电", industry_f10: { l3: "冰洗" } }) !== "appliance") {
    fails.push("appliance-l3-fallback");
  }
  if (finKindFromCard({ f100: "饮料乳品", industry_f10: { l3: "乳品" } }) !== "brand_consumer") {
    fails.push("dairy-l3-brand");
  }
  return fails;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    positional: ["industry"],
    booleans: ["selfTest", "self-test"],
  });
  if (args.selfTest || args["self-test"]) {
    const fails = selfTest();
    if (fails.length) {
      console.error(`self-test FAIL ${fails.length}`);
      for (const f of fails) console.error(`  ${f}`);
      return 1;
    }
    console.log(`self-test OK ${SELF_CASES.length} cases`);
    return 0;
  }
  const raw = args.industry;
  if (!raw) {
    console.error("usage: node industry_map.js <行业名> | --self-test");
    return 1;
  }
  console.log(
    JSON.stringify(
      { f100: normalizeIndustry(raw), fin_kind: finKindFromF100(raw) },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
