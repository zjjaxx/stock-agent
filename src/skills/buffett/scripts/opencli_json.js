#!/usr/bin/env node
/**
 * opencli browser / adapter 输出解析公共库（buffett 抓数脚本共用）。
 *
 * 本轮实跑约定：
 * - browser 直开 API URL → eval document.body.innerText → JSON
 * - opencli 可能在 stdout 夹带 upgrade banner，取首尾大括号/中括号解析
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

export function stripJsonText(raw) {
  const objStart = raw.indexOf("{");
  const arrStart = raw.indexOf("[");
  const starts = [objStart, arrStart].filter((i) => i >= 0);
  if (!starts.length) {
    throw new Error("输出中找不到 JSON（{...} 或 [...]）");
  }
  const start = Math.min(...starts);
  const end = raw[start] === "{" ? raw.lastIndexOf("}") : raw.lastIndexOf("]");
  if (end < start) throw new Error("JSON 起止不匹配");
  return raw.slice(start, end + 1);
}

export function parseJsonText(raw) {
  return JSON.parse(stripJsonText(raw));
}

export function runOpencli(args, { timeoutMs = 120_000, check = false } = {}) {
  const proc = spawnSync("opencli", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (check && proc.status !== 0) {
    throw new Error(
      `opencli ${args.join(" ")} failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").slice(0, 400)}`,
    );
  }
  return {
    returncode: proc.status ?? 1,
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
  };
}

export function browserOpen(session, url, { timeoutMs = 120_000 } = {}) {
  const proc = runOpencli(["browser", session, "open", url], { timeoutMs });
  if (proc.returncode !== 0) {
    const err = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`browser open 失败 (exit ${proc.returncode}): ${err.slice(0, 300)}`);
  }
}

export function browserEval(session, js, { timeoutMs = 60_000 } = {}) {
  const proc = runOpencli(["browser", session, "eval", js], { timeoutMs });
  if (proc.returncode !== 0) {
    const err = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`browser eval 失败 (exit ${proc.returncode}): ${err.slice(0, 300)}`);
  }
  return proc.stdout || "";
}

export function browserWaitText(session, text, { timeoutMs = 20_000 } = {}) {
  const proc = runOpencli(
    ["browser", session, "wait", "text", text, "--timeout", String(timeoutMs)],
    { timeoutMs: timeoutMs + 10_000 },
  );
  if (proc.returncode !== 0) {
    const err = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`wait text ${JSON.stringify(text)} 失败: ${err.slice(0, 300)}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function browserFetchJson(session, url, { sleepS = 0.7, retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      browserOpen(session, url);
      sleep(Math.round(sleepS * 1000));
      const raw = browserEval(
        session,
        '(function(){return document.body && document.body.innerText ? document.body.innerText : "";})()',
      );
      return parseJsonText(raw);
    } catch (exc) {
      lastErr = exc;
      sleep(400);
    }
  }
  throw new Error(`browser_fetch_json 失败: ${url} (${lastErr})`);
}

export function secucode(code, market) {
  const c = String(code).trim();
  const m = String(market).trim().toUpperCase();
  if (c.includes(".")) return c.toUpperCase();
  if (!["SH", "SZ", "BJ"].includes(m)) throw new Error(`无效市场: ${market}`);
  return `${c}.${m}`;
}

/** push2his secid：沪 1.xxxxxx，深/北 0.xxxxxx */
export function secid(code, market) {
  let c = String(code).trim();
  let m = market;
  if (c.includes(".")) {
    const [num, mkt] = c.split(".", 2);
    m = mkt;
    c = num;
  }
  m = String(m).trim().toUpperCase();
  const prefix = m === "SH" ? "1" : "0";
  return `${prefix}.${c}`;
}

export function marketFromCode(code) {
  const raw = String(code).trim().toUpperCase();
  if (raw.includes(".")) return raw.split(".", 2)[1];
  if (raw.length === 6 && /^\d{6}$/.test(raw)) {
    if ("69".includes(raw[0])) return "SH";
    if ("03".includes(raw[0])) return "SZ";
    if ("48".includes(raw[0])) return "BJ";
  }
  throw new Error(`无法推断市场: ${code}`);
}

/** 解析东财常见市值字符串：'2246.16亿' / 数字。返回元。 */
export function parseYiNumber(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/,/g, "").trim();
  const m = s.match(/^([+-]?\d+(?:\.\d+)?)(万亿|亿|万)?$/);
  if (!m) {
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }
  let v = Number(m[1]);
  const unit = m[2];
  if (unit === "万亿") v *= 1e12;
  else if (unit === "亿") v *= 1e8;
  else if (unit === "万") v *= 1e4;
  return v;
}

export function datacenterUrl(
  reportName,
  sc,
  { pageSize = 50, sortColumns = null, sortTypes = "-1" } = {},
) {
  const filt = encodeURIComponent(`(SECUCODE="${sc}")`);
  let url =
    "https://datacenter.eastmoney.com/securities/api/data/v1/get" +
    `?reportName=${reportName}&columns=ALL&filter=${filt}` +
    `&pageNumber=1&pageSize=${pageSize}&source=HSF10&client=PC`;
  if (sortColumns) {
    url += `&sortTypes=${sortTypes}&sortColumns=${sortColumns}`;
  }
  return url;
}

export function datacenterRows(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const data = payload.result?.data;
  return Array.isArray(data) ? data : [];
}

export function readJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function writeJson(path, data) {
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * 极简 CLI：positional + --flag value / --flag=value / -o
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ positional?: string[], defaults?: Record<string, unknown>, booleans?: string[] }} opts
 */
export function parseArgs(argv, { positional = [], defaults = {}, booleans = [] } = {}) {
  const out = { ...defaults };
  for (const b of booleans) {
    if (out[b] === undefined) out[b] = false;
  }
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key;
      let val;
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (booleans.includes(key) || booleans.includes(camelKey(key))) {
          out[key] = true;
          out[camelKey(key)] = true;
          continue;
        }
        val = argv[++i];
        if (val === undefined) throw new Error(`缺少参数值: --${key}`);
      }
      out[key] = val;
      out[camelKey(key)] = val;
      continue;
    }
    if (a.startsWith("-") && a.length === 2) {
      const short = a[1];
      const map = { o: "output" };
      const key = map[short] || short;
      if (booleans.includes(key)) {
        out[key] = true;
        continue;
      }
      const val = argv[++i];
      if (val === undefined) throw new Error(`缺少参数值: -${short}`);
      out[key] = val;
      continue;
    }
    pos.push(a);
  }
  positional.forEach((name, idx) => {
    if (pos[idx] !== undefined) out[name] = pos[idx];
  });
  out._ = pos;
  return out;
}

function camelKey(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
