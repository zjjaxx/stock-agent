#!/usr/bin/env node
/**
 * 人工审批候选锚。没有 --yes 时只预览，不会修改正式锚。
 *
 * 用法:
 *   node approve_anchors.js --candidate ~/Desktop/temp/buffett_anchors_candidate_YYYYMMDD.json
 *   node approve_anchors.js --candidate ... --yes
 */

import fs from "node:fs";
import path from "node:path";
import {
  APPROVED_ANCHORS,
  APPROVED_ANCHOR_PATH,
} from "./anchor_config.js";
import { parseArgs, readJsonFile } from "./opencli_json.js";

function rawValue(metric) {
  return metric?.anchor ?? metric?.band ?? metric?.cv_cuts ?? metric?.cuts ?? null;
}

function changes(candidate) {
  const out = [];
  for (const [industry, node] of Object.entries(candidate.industries || {})) {
    for (const [metric, value] of Object.entries(node.metrics || {})) {
      if (value.calibration_status !== "calibrated") continue;
      const before = rawValue(APPROVED_ANCHORS.industries?.[industry]?.metrics?.[metric]);
      const after = rawValue(value);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        out.push({ scope: industry, metric, before, after, n: value.n ?? node.n });
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["yes", "force"] });
  if (!args.candidate) throw new Error("usage: node approve_anchors.js --candidate PATH [--yes]");
  const candidate = readJsonFile(args.candidate);
  if (candidate?.status !== "candidate" || candidate?.schema_version !== 2) {
    throw new Error("候选文件状态或 schema_version 非法（须为 2）");
  }
  if (candidate.pb_calibration_enabled !== false) {
    throw new Error("拒绝审批：当前阶段 PB 校准必须为 false");
  }
  if (
    candidate.source_approved_version !== APPROVED_ANCHORS.version &&
    !args.force
  ) {
    throw new Error(
      `候选基于 ${candidate.source_approved_version}，当前正式版为 ${APPROVED_ANCHORS.version}；请重跑校准，或明确 --force`,
    );
  }
  const list = changes(candidate);
  console.log(`candidate=${candidate.version}, changes=${list.length}`);
  for (const item of list) {
    console.log(
      `${item.scope} ${item.metric}: ${JSON.stringify(item.before)} -> ${JSON.stringify(item.after)} (N=${item.n})`,
    );
  }
  if (!args.yes) {
    console.log("仅预览；复核报告后加 --yes 才会写入 anchors.approved.json");
    return;
  }

  const approved = {
    ...candidate,
    status: "approved",
    version: `approved-${new Date().toISOString().slice(0, 10)}`,
    approved_at: new Date().toISOString(),
    source_candidate: path.resolve(args.candidate),
    industries: {
      ...(APPROVED_ANCHORS.industries || {}),
      ...(candidate.industries || {}),
    },
  };
  delete approved.source_approved_version;
  fs.writeFileSync(APPROVED_ANCHOR_PATH, `${JSON.stringify(approved, null, 2)}\n`, "utf8");
  console.log(`approved: ${APPROVED_ANCHOR_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
