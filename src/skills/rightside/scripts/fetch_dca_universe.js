#!/usr/bin/env node
/**
 * Step0：拉取定投回测标的日线 → ~/Desktop/temp/dca_*_day.json
 *
 * 默认标的（一律 ETF 前复权，口径一致）：
 *   hs300     沪深300ETF 510300 前复权
 *   zzhl      中证红利ETF 515080 前复权
 *   hldf      红利低波ETF 512890 前复权
 *   hldf_idx  红利低波100 指数 2.930955（对照，可选）
 *
 *   node fetch_dca_universe.js
 *   node fetch_dca_universe.js --symbols hs300,zzhl,hldf --limit 5000
 */

import fs from "node:fs";
import {
  browserFetchJson,
  httpGetJson,
  parseArgs,
  tmpDir,
  tmpPath,
  writeJson,
} from "./opencli_json.js";

const KLINE_HOSTS = ["push2his.eastmoney.com", "push2delay.eastmoney.com"];

const UNIVERSE = {
  hs300: {
    key: "hs300",
    label: "沪深300ETF",
    secid: "1.510300",
    fqt: 1,
    adjust: "forward",
    file: "dca_hs300_day.json",
  },
  zzhl: {
    key: "zzhl",
    label: "中证红利ETF",
    secid: "1.515080",
    fqt: 1,
    adjust: "forward",
    file: "dca_zzhl_day.json",
  },
  hldf: {
    key: "hldf",
    label: "红利低波ETF",
    secid: "1.512890",
    fqt: 1,
    adjust: "forward",
    file: "dca_hldf_day.json",
  },
  hldf_idx: {
    key: "hldf_idx",
    label: "红利低波100",
    secid: "2.930955",
    fqt: 0,
    adjust: "none",
    file: "dca_hldf_idx_day.json",
  },
};

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function klinePayloadEmpty(payload) {
  if (!payload || typeof payload !== "object") return true;
  if (payload.rc != null && Number(payload.rc) !== 0) return true;
  return !(payload.data?.klines || []).length;
}

function barsFromPush2his(payload) {
  const out = [];
  for (const line of payload.data?.klines || []) {
    const parts = String(line).split(",");
    if (parts.length < 6) continue;
    out.push({
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: parts[5] ? Number(parts[5]) : null,
    });
  }
  return out;
}

async function fetchKlinePayload(secid, { klt, limit, fqt, session }) {
  const path =
    "/api/qt/stock/kline/get" +
    `?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    `&klt=${klt}&fqt=${fqt}&end=20500101&lmt=${limit}`;
  const errors = [];
  for (let round = 0; round < 2; round++) {
    if (round) sleep(3000);
    for (const host of KLINE_HOSTS) {
      try {
        const payload = await httpGetJson(`https://${host}${path}`, { retries: 1 });
        if (klinePayloadEmpty(payload)) {
          errors.push(`${host}: rc=${payload?.rc ?? "?"} klines=0`);
          continue;
        }
        return { payload, source: `${host} (http)` };
      } catch (exc) {
        errors.push(`${host}: ${String(exc.message || exc).slice(0, 100)}`);
      }
    }
  }
  try {
    const payload = browserFetchJson(session, `https://${KLINE_HOSTS[0]}${path}`, {
      sleepS: 1.2,
    });
    if (!klinePayloadEmpty(payload)) {
      return { payload, source: `${KLINE_HOSTS[0]} (browser)` };
    }
    errors.push(`browser: rc=${payload?.rc ?? "?"} klines=0`);
  } catch (exc) {
    errors.push(`browser: ${String(exc.message || exc).slice(0, 100)}`);
  }
  throw new Error(`K线失败 ${secid}: ${errors.slice(-4).join(" | ")}`);
}

async function fetchOne(spec, { limit, session }) {
  const { payload, source } = await fetchKlinePayload(spec.secid, {
    klt: "101",
    limit,
    fqt: spec.fqt,
    session,
  });
  const bars = barsFromPush2his(payload);
  if (!bars.length) throw new Error(`${spec.key} bars empty`);
  return {
    key: spec.key,
    label: spec.label,
    name: payload?.data?.name || spec.label,
    code: payload?.data?.code || null,
    secid: spec.secid,
    period: "day",
    adjust: spec.adjust,
    fqt: spec.fqt,
    source,
    count: bars.length,
    first: bars[0].date,
    last: bars.at(-1).date,
    bars,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      symbols: "hs300,hldf,zzhl,hldf_idx",
      limit: "5000",
      session: "rightside-kline",
      outdir: tmpDir(),
    },
  });
  const keys = String(args.symbols)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Number(args.limit) || 5000;
  const outdir = args.outdir || tmpDir();
  fs.mkdirSync(outdir, { recursive: true });

  const summary = [];
  for (const key of keys) {
    const spec = UNIVERSE[key];
    if (!spec) {
      console.error(`unknown symbol key: ${key} (known: ${Object.keys(UNIVERSE).join(",")})`);
      return 1;
    }
    const data = await fetchOne(spec, { limit, session: args.session });
    const fp = `${outdir.replace(/\/$/, "")}/${spec.file}`;
    writeJson(fp, data);
    summary.push({
      key: data.key,
      name: data.name,
      secid: data.secid,
      n: data.count,
      first: data.first,
      last: data.last,
      file: fp,
      source: data.source,
    });
    console.error(`ok ${data.key} ${data.name} n=${data.count} ${data.first}→${data.last}`);
  }
  const metaPath = tmpPath("dca_universe_meta.json");
  writeJson(metaPath, { as_of: new Date().toISOString(), symbols: summary });
  console.log(JSON.stringify({ meta: metaPath, symbols: summary }, null, 2));
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c ?? 0));
}

export { UNIVERSE };
