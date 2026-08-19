#!/usr/bin/env node
/**
 * 已批准 f100 锚读取器。日常评分只读 anchors.approved.json，候选锚不会自动生效。
 * PB 第二阶段暂不校准；有 f100 PB 锚则用，否则 PB 维仅同类分位。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APPROVED_ANCHOR_PATH = path.resolve(HERE, "../references/anchors.approved.json");

function readApproved() {
  const data = JSON.parse(fs.readFileSync(APPROVED_ANCHOR_PATH, "utf8"));
  if (data?.status !== "approved" || !data?.industries) {
    throw new Error("anchors.approved.json 必须为 approved 状态且包含 industries");
  }
  if (data.schema_version !== 2) {
    throw new Error("anchors.approved.json schema_version 须为 2（纯 f100）");
  }
  if (data.pb_calibration_enabled !== false) {
    throw new Error("当前阶段禁止启用 PB 校准");
  }
  return data;
}

export const APPROVED_ANCHORS = readApproved();

export function normalizeIndustry(value) {
  return String(value || "")
    .trim()
    .replace(/[ⅠⅡⅢIVX\s]+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .trim();
}

/** 银行/保险：校准跳过负债/ROIC/毛利率。证券要留负债锚，不算在内。 */
export function isFinancialF100(f100) {
  const key = normalizeIndustry(f100);
  return /银行|保险/.test(key);
}

/** 非金现金流口径（FCF/ROIC/毛利率）。银/保/证都不走。 */
export function usesCorpCashMetrics(f100) {
  const key = normalizeIndustry(f100);
  return !/银行|保险|证券|多元金融/.test(key);
}

function usable(metric) {
  return metric && metric.calibration_status !== "insufficient";
}

/** 仅按 f100 读取已批准锚；无该行业则 metrics 为空。 */
export function anchorProfile(f100 = "") {
  const industryKey = normalizeIndustry(f100);
  const industryNode = industryKey ? APPROVED_ANCHORS.industries?.[industryKey] : null;
  const metrics = {};
  const sources = {};

  for (const [key, metric] of Object.entries(industryNode?.metrics || {})) {
    if (!usable(metric)) continue;
    metrics[key] = metric;
    sources[key] = {
      level: "f100",
      key: industryKey,
      n: metric.n ?? industryNode?.n ?? null,
      confidence: industryNode?.confidence || "calibrated",
    };
  }

  return {
    version: APPROVED_ANCHORS.version,
    industryKey,
    metrics,
    sources,
    hasIndustry: Boolean(industryNode),
  };
}

export function metricSource(profile, metric) {
  const source = profile?.sources?.[metric];
  if (!source) return `锚版本=${APPROVED_ANCHORS.version};f100=${profile?.industryKey || "无"}`;
  const n = source.n == null ? "" : `,N=${source.n}`;
  return `锚=f100:${source.key}${n};版本=${APPROVED_ANCHORS.version}`;
}
