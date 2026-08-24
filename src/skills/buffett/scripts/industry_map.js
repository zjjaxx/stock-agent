#!/usr/bin/env node
/**
 * 东财行业名 → 策略类别 A–H（画像锚；数字维打分见 score_numeric.js）。
 * 只匹配行业字段（f100 / BOARD_NAME），禁止用股票简称或代码名单。
 *
 * 用法:
 *   node industry_map.js "电力"
 *   node industry_map.js --self-test
 */

import { parseArgs } from "./opencli_json.js";

export const CLASS_META = {
  A: {
    name: "公用/特许经营",
    pb: 2.5,
    roe: 8,
    pay: [50, 80],
    debt: 65,
  },
  B: {
    name: "运营商",
    pb: 1.5,
    roe: 9,
    pay: [50, 70],
    debt: 55,
  },
  C: {
    name: "能源混合",
    pb: 1.5,
    roe: 10,
    pay: [40, 70],
    debt: 55,
  },
  D: {
    name: "强周期",
    pb: 1.0,
    roe: 12,
    pay: [30, 60],
    debt: 60,
  },
  E: {
    name: "银行/保险",
    pb: 0.8,
    roe: 9,
    pay: [25, 40],
    debt: null,
  },
  F: {
    name: "建筑交运",
    pb: 0.8,
    roe: 10,
    pay: [20, 40],
    debt: 75,
  },
  G: {
    name: "通用兜底",
    pb: 1.2,
    roe: 12,
    pay: [30, 70],
    debt: 60,
  },
  /** 白酒：轻资产高 ROE，PB 常在 2–8；不可套 G 类 PB≤1.2（否则全维封 0）。 */
  H: {
    name: "白酒",
    pb: 6,
    roe: 20,
    pay: [50, 80],
    debt: 40,
  },
};

/** 无 f100 PB 锚时的类别软锚（不做十年校准，只给带宽）。可带 l3，港口/航运等复合 f100 按三级行业分。 */
export function classPbAnchor(f100, extra = {}) {
  const { cls } = classifyIndustry({ f100, l3: extra.l3, l2: extra.l2 });
  const pb = CLASS_META[cls]?.pb;
  return Number.isFinite(Number(pb)) ? Number(pb) : null;
}

/** 同行比较键：优先东财 F10 三级行业 l3，无 l3 时回退 ulist f100。禁止用股票简称。 */
export function peerMeta(card = {}) {
  const l3 = normalizeIndustry(card.industry_f10?.l3 || card.industry?.l3 || "");
  const f100 = normalizeIndustry(card.f100 || "");
  if (l3) return { key: `l3:${l3}`, label: l3, source: "l3", f100 };
  if (f100) return { key: `f100:${f100}`, label: f100, source: "f100", f100 };
  return { key: "ind:", label: "", source: null, f100: "" };
}

/** 先匹配更具体的行业名；同一字符串只取第一条命中。 */
const RULES = [
  { cls: "E", re: /银行/, name: "银行", cycle: false },
  { cls: "E", re: /保险/, name: "保险", cycle: false },
  { cls: "H", re: /白酒/, name: "白酒", cycle: false },
  { cls: "B", re: /通信服务|电信运营|通信运营/, name: "运营商", cycle: false },
  { cls: "A", re: /核力发电|水力发电|风力发电|新能源发电|电力|热电/, name: "公用事业", cycle: false },
  { cls: "A", re: /燃气|水务|供水|公用事业|环境治理/, name: "公用事业", cycle: false },
  { cls: "A", re: /高速公路|铁路公路/, name: "收费公路/铁路", cycle: false },
  { cls: "C", re: /煤炭/, name: "能源混合", cycle: true },
  { cls: "C", re: /油气|炼化|石油石化/, name: "能源混合", cycle: true },
  { cls: "D", re: /钢铁|普钢|有色/, name: "强周期", cycle: true },
  { cls: "D", re: /航运|航空机场/, name: "强周期", cycle: true },
  { cls: "F", re: /港口/, name: "建筑交运", cycle: false },
  { cls: "F", re: /建筑|基础建设|房屋建设|专业工程|基建/, name: "建筑交运", cycle: false },
];

export function normalizeIndustry(raw) {
  return String(raw || "")
    .replace(/[ⅠⅡⅢIVX\s]/g, "")
    .trim();
}

/**
 * 权重表种类只认东财行业字段（优先 l3，过细回退 f100），禁止用不良/偿付/NIM 字段反推。
 * 证券/多元金融走 broker；非金按生意形态拆模板，未命中回 corp。
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

/** 走非金 FCF/ROIC/毛利率/负债维度的种类（银/保/证除外）。 */
export function isCorpCashKind(kind) {
  return (
    kind === "corp" ||
    kind === "utility" ||
    kind === "brand_consumer" ||
    kind === "resource_cycle" ||
    kind === "infra_construction" ||
    kind === "appliance" ||
    kind === "equip_mfg" ||
    kind === "tech_hardware"
  );
}

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

function matchRules(text) {
  const t = normalizeIndustry(text);
  if (!t) return null;
  for (const rule of RULES) {
    if (rule.re.test(t)) {
      return {
        cls: rule.cls,
        ind_name: rule.name,
        cycle_caution: rule.cycle || rule.cls === "D",
        unmapped: false,
      };
    }
  }
  return null;
}

/**
 * @param {{ f100?: string, l1?: string, l2?: string, l3?: string, em2016?: string, industry?: string }} src
 */
export function classifyIndustry(src = {}) {
  const f100 = src.f100 || src.industry || "";
  const ordered = [src.l3, src.l2, f100, src.l1, src.em2016].filter((x) => String(x || "").trim());
  for (const text of ordered) {
    const hit = matchRules(text);
    if (hit) {
      return {
        ...hit,
        industry: normalizeIndustry(text),
        industry_fields: { f100, l1: src.l1, l2: src.l2, l3: src.l3, em2016: src.em2016 },
      };
    }
  }
  const blob = ordered.map(normalizeIndustry).join(" ");
  if (blob) {
    const hit = matchRules(blob);
    if (hit) {
      return {
        ...hit,
        industry: blob,
        industry_fields: { f100, l1: src.l1, l2: src.l2, l3: src.l3, em2016: src.em2016 },
      };
    }
  }
  const g = CLASS_META.G;
  return {
    cls: "G",
    ind_name: g.name,
    cycle_caution: false,
    unmapped: true,
    industry: blob || null,
    industry_fields: { f100, l1: src.l1, l2: src.l2, l3: src.l3, em2016: src.em2016 },
  };
}

const SELF_CASES = [
  ["电力", "A", "中国核电/川投/长电"],
  ["核力发电", "A", "中国核电 L3"],
  ["水力发电", "A", "川投能源 L3"],
  ["燃气Ⅱ", "A", "深圳燃气"],
  ["铁路公路", "A", "宁沪高速/京沪高铁"],
  ["高速公路", "A", "宁沪 L3"],
  ["通信服务", "B", "中国移动"],
  ["煤炭开采", "C", "神华/中煤"],
  ["油气开采Ⅱ", "C", "中国海油"],
  ["炼化及贸易", "C", "中国石油"],
  ["普钢", "D", "宝钢"],
  ["航运港口", "D", "中远海控 f100"],
  ["航运", "D", "中远 L3"],
  ["港口", "F", "上港 L3"],
  ["银行Ⅱ", "E", "招商银行"],
  ["保险Ⅱ", "E", "中国平安"],
  ["房屋建设Ⅱ", "F", "中国建筑"],
  ["基础建设", "F", "中国交建"],
  ["白酒Ⅱ", "H", "白酒独立画像，不进 G"],
  ["白色家电", "G", "格力"],
  ["房地产开发", "G", "地产"],
];

export function selfTest() {
  const fails = [];
  for (const [raw, want, note] of SELF_CASES) {
    const got = classifyIndustry({ f100: raw });
    if (got.cls !== want) {
      fails.push(`${raw} want ${want} got ${got.cls} (${note})`);
    }
  }
  const nuclear = classifyIndustry({ f100: "电力", l3: "核力发电" });
  if (nuclear.cls !== "A") fails.push("核电 L3+f100 应为 A");
  const liquor = classifyIndustry({ f100: "白酒Ⅱ" });
  if (liquor.cls !== "H") fails.push("白酒应为 H");
  if (liquor.cls === "A") fails.push("白酒不得进 A");
  if (CLASS_META.H.pb < 4) fails.push("白酒 PB 软锚过低");
  if (classPbAnchor("银行") !== 0.8) fails.push("银行类别软锚应为 0.8");
  if (classPbAnchor("白酒Ⅱ") !== 6) fails.push("白酒类别软锚应为 6");
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
  if (!isCorpCashKind("utility") || isCorpCashKind("bank")) fails.push("corp-cash-kind");
  if (!isCorpCashKind("appliance") || !isCorpCashKind("tech_hardware")) fails.push("new-cash-kind");
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
  console.log(JSON.stringify(classifyIndustry({ f100: raw }), null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
