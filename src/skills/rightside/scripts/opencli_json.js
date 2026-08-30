#!/usr/bin/env node
/**
 * opencli browser / adapter 输出解析公共库（rightside 抓数脚本共用）。
 *
 * 本轮实跑约定：
 * - browser 直开 API URL → eval document.body.innerText → JSON
 * - opencli 可能在 stdout 夹带 upgrade banner，取首尾大括号/中括号解析
 * - 落盘缓存统一用 `~/Desktop/temp/`（见 tmpPath），禁止默认写系统 /tmp 或仓库 tmp/
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/** 缓存根：`~/Desktop/temp`，不存在则创建。 */
export function tmpDir() {
  const dir = path.join(os.homedir(), "Desktop", "temp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `~/Desktop/temp/<name>` 的绝对路径。 */
export function tmpPath(name) {
  return path.join(tmpDir(), name);
}

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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const HTTP_UA = "Mozilla/5.0";
const HTTP_REFERER = "https://quote.eastmoney.com/";

/** Node https，强制 IPv4。东财 push2 在 macOS 上走 IPv6/HTTP2 常 SSL_ERROR_SYSCALL。 */
export function nodeHttpsJson(url, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (exc) {
      finish(exc);
      return;
    }
    const req = https.request(
      {
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        family: 4,
        servername: parsed.hostname,
        timeout: timeoutMs,
        headers: {
          Host: parsed.hostname,
          "User-Agent": HTTP_UA,
          Referer: HTTP_REFERER,
          Accept: "application/json,text/plain,*/*",
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode || 0) >= 400) {
              finish(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            finish(null, parseJsonText(text));
          } catch (exc) {
            finish(exc);
          }
        });
      },
    );
    req.on("error", (exc) => finish(exc));
    req.on("timeout", () => {
      req.destroy();
      finish(new Error("https timeout"));
    });
    req.end();
  });
}

/** curl 强制 IPv4 + HTTP/1.1；不要 --compressed（东财 push2 易 SSL_ERROR_SYSCALL）。 */
export function curlJson(url, extraArgs = []) {
  const proc = spawnSync(
    "curl",
    [
      "-sS",
      "-4",
      "--http1.1",
      "-A",
      HTTP_UA,
      "-H",
      `Referer: ${HTTP_REFERER}`,
      "--max-time",
      "30",
      ...extraArgs,
      url,
    ],
    { encoding: "utf8" },
  );
  if (proc.status !== 0) throw new Error((proc.stderr || "curl failed").slice(0, 300));
  return parseJsonText(proc.stdout || "");
}

function curlJsonSimple(url) {
  const proc = spawnSync("curl", ["-sS", "-A", HTTP_UA, "--max-time", "30", url], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || "curl failed").slice(0, 300));
  return parseJsonText(proc.stdout || "");
}

export async function httpGetJson(url, { retries = 1 } = {}) {
  const errors = [];
  const attempts = [
    () => curlJsonSimple(url),
    () => curlJson(url),
    () => nodeHttpsJson(url),
    () => curlJson(url, ["--tlsv1.2"]),
  ];
  for (let round = 0; round < retries; round++) {
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (exc) {
        errors.push(String(exc.message || exc));
        sleep(200);
      }
    }
  }
  throw new Error(errors.slice(-4).join(" | "));
}

export function browserFetchJson(session, url, { sleepS = 0.7, retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      browserOpen(session, url);
      sleep(Math.round(sleepS * 1000));
      const raw = browserEval(
        session,
        '(function(){var t=document.body&&document.body.innerText?document.body.innerText:"";if(t&&t.indexOf("{")>=0)return t;var pre=document.querySelector("pre");return (pre&&pre.textContent)||t;})()',
      );
      return parseJsonText(raw);
    } catch (exc) {
      lastErr = exc;
      sleep(400);
    }
  }
  throw new Error(`browser_fetch_json 失败: ${url} (${lastErr})`);
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
  for (const [key, val] of Object.entries(defaults)) {
    out[camelKey(key)] = val;
  }
  for (const b of booleans) {
    if (out[b] === undefined) out[b] = false;
    if (out[camelKey(b)] === undefined) out[camelKey(b)] = false;
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
