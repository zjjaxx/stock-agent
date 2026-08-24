#!/usr/bin/env node
/**
 * Step0：东财条件选股点选 + 出池（buffett 固化入口）。
 *
 * 唯一出池路径：点「去选股」后扫 Result 页 el-table（固定列 + 滚动列按行对齐）。
 *
 * 用法:
 *   node run_step0_xuangu.js -o ~/Desktop/temp/buffett_xuangu_result.json
 *   node run_step0_xuangu.js --session buffett-xg-demo --pool-json ~/Desktop/temp/buffett_pool.json
 *   node run_step0_xuangu.js --bond-json ~/Desktop/temp/buffett_bond.json
 *   node run_step0_xuangu.js --bond 1.70
 *
 * 股息下限 = 中国10Y国债 × 2（无 --bond / --bond-json 时先抓 Investing）。
 */

import fs from "node:fs";
import {
  buffettTmp,
  marketFromCode,
  parseArgs,
  parseJsonText,
  parseYiNumber,
  readJsonFile,
  runOpencli,
} from "./opencli_json.js";
import { fetchBondYield, step0DivFloor } from "./fetch_bond_yield.js";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function oc(session, args, timeoutMs = 120_000) {
  return runOpencli(["browser", session, ...args], { timeoutMs });
}

function ocJson(session, ...args) {
  const proc = oc(session, args);
  if (proc.returncode !== 0) {
    throw new Error(
      `opencli ${args.join(" ")} failed: ${(proc.stderr || proc.stdout).slice(0, 400)}`,
    );
  }
  return parseJsonText(proc.stdout || "");
}

function findRef(session, { text = null, css = null } = {}) {
  const args = ["find"];
  if (text != null) args.push("--text", text);
  if (css != null) args.push("--css", css);
  const data = ocJson(session, ...args);
  return data.entries || [];
}

function findRefSoft(session, opts) {
  try {
    return findRef(session, opts);
  } catch {
    return [];
  }
}

function clickRef(session, ref) {
  const proc = oc(session, ["click", String(ref)]);
  if (proc.returncode !== 0) {
    throw new Error(`click ${ref} failed: ${(proc.stderr || proc.stdout).slice(0, 300)}`);
  }
}

function fillRef(session, ref, value) {
  const proc = oc(session, ["fill", String(ref), value]);
  if (proc.returncode !== 0) {
    throw new Error(`fill ${ref} failed: ${(proc.stderr || proc.stdout).slice(0, 300)}`);
  }
}

/** Element UI spinbutton 常 fill 后值未进模型；必须 get value 验收。 */
function getValue(session, ref) {
  const data = ocJson(session, "get", "value", String(ref));
  return data.value == null ? "" : String(data.value).trim();
}

function fillVerified(session, ref, expected, { retries = 3 } = {}) {
  const want = String(expected).trim();
  let last = "";
  for (let i = 0; i < retries; i++) {
    // 先点一下聚焦，再填；Element 受控输入更稳
    try {
      clickRef(session, ref);
    } catch {
      /* ignore */
    }
    sleep(120);
    fillRef(session, ref, want);
    sleep(200);
    last = getValue(session, ref);
    if (last === want) return last;
    if (want !== "" && Number(last) === Number(want) && Number.isFinite(Number(want))) {
      return last;
    }
    // 偶发尾零/空：清空再填一次
    sleep(150);
  }
  throw new Error(`fill 校验失败 ref=${ref} want=${want} got=${JSON.stringify(last)}`);
}

function evalJs(session, js) {
  const proc = oc(session, ["eval", js]);
  if (proc.returncode !== 0) {
    throw new Error(`eval failed: ${(proc.stderr || proc.stdout).slice(0, 300)}`);
  }
  return proc.stdout || "";
}

function chips(session) {
  const raw = evalJs(
    session,
    '(function(){return JSON.stringify([].map.call(document.querySelectorAll(".index-tag"),' +
      "function(e){return e.textContent.trim();}));})()",
  );
  return parseJsonText(raw);
}

function hasDividendChip(chipList, loStr) {
  const want = Number(loStr);
  return (chipList || []).some((x) => {
    const s = String(x).replace(/\s/g, "");
    const m = s.match(/最新股息率([\d.]+)%-100%/);
    if (!m || !Number.isFinite(want)) return false;
    return Math.abs(Number(m[1]) - want) < 0.051;
  });
}

function resolveBond(args) {
  const bondFile = args.bondJson || args["bond-json"];
  if (bondFile) {
    const data = readJsonFile(bondFile);
    if (data?.yield_pct == null) throw new Error("bond JSON 缺少 yield_pct");
    return data;
  }
  if (args.bond != null && args.bond !== "") {
    const y = Number(args.bond);
    if (!Number.isFinite(y) || y <= 0) throw new Error(`无效 --bond: ${args.bond}`);
    return { yield_pct: y, source: "cli --bond", fetched_at: new Date().toISOString() };
  }
  return fetchBondYield({ session: args.bondSession || args["bond-session"] || "buffett-bond" });
}

function dismissPopover(session) {
  const proc = oc(session, ["keys", "Escape"]);
  if (proc.returncode !== 0) {
    // keys 不可用时忽略，后续靠重新 open 弹层
    return;
  }
  sleep(250);
}

function pickRef(entries, pred) {
  for (const e of entries) {
    if (pred(e)) return Number(e.ref);
  }
  throw new Error("找不到目标元素");
}

function waitVisibleMainItem(session, text, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const js = `(function(){
  var want=${JSON.stringify(text)};
  var items=document.querySelectorAll(".listItem.main-item");
  for(var i=0;i<items.length;i++){
    var e=items[i];
    if((e.textContent||"").trim()!==want) continue;
    var r=e.getBoundingClientRect();
    if(r.width>0&&r.height>0) return "1";
  }
  return "0";
})()`;
  while (Date.now() < deadline) {
    const ok = evalJs(session, js).trim().split(/\r?\n/).pop();
    if (ok === "1") {
      const entries = findRef(session, { css: ".listItem.main-item" });
      return pickRef(entries, (e) => e.text === text);
    }
    sleep(400);
  }
  throw new Error(`等待可见条件项超时: ${text}`);
}

function setMarketCap(session) {
  const ref = waitVisibleMainItem(session, "总市值");
  clickRef(session, ref);
  sleep(500);
  const opts = findRef(session, { css: ".pickerPopoverContainer .listItem" });
  clickRef(session, pickRef(opts, (e) => e.text === ">500亿"));
  sleep(300);
  // 部分版本点选项即落 chip，确定按钮可能已不在；有则点，无则靠 chip 验收
  const btns = findRefSoft(session, {
    css: ".pickerPopoverContainer .el-button--primary",
  });
  if (btns.length) {
    clickRef(session, Number(btns[0].ref));
    sleep(350);
  }
  const chipList = chips(session);
  if (!chipList.some((x) => String(x).includes("总市值>500亿"))) {
    throw new Error(`市值 chip 未落地: ${JSON.stringify(chipList)}`);
  }
}

function clickFundamentalsTab(session) {
  // 优先 CSS：页面上另有导航文案「基本面」，find --text 易点错
  try {
    clickCss(session, "#tab-基本面");
  } catch {
    const tabs = findRef(session, { text: "基本面" });
    clickRef(
      session,
      pickRef(
        tabs,
        (e) =>
          e.attrs?.id === "tab-基本面" || (e.text === "基本面" && e.role === "tab"),
      ),
    );
  }
  sleep(400);
  waitVisibleMainItem(session, "总市值");
}

/**
 * 自定义股息区间 [国债×2, 100]。
 * 历史事故：只 fill 不验值、立刻点确定 → chip 不出现或上限被默认成 5。
 */
function setDividend(session, loStr, { attempts = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      dismissPopover(session);
      const ref = waitVisibleMainItem(session, "最新股息率");
      clickRef(session, ref);
      sleep(500);
      const inputs = findRef(session, { css: ".pickerPopoverContainer .el-input__inner" });
      if (inputs.length < 2) {
        throw new Error(`股息率自定义输入框不足 2 个（got ${inputs.length}）`);
      }
      const lo = fillVerified(session, inputs[0].ref, loStr);
      sleep(150);
      const hi = fillVerified(session, inputs[1].ref, "100");
      // 点确定前再读一次，防止第二次 fill 冲掉第一次
      const lo2 = getValue(session, inputs[0].ref);
      const hi2 = getValue(session, inputs[1].ref);
      if ((lo2 !== loStr && Number(lo2) !== Number(loStr)) || hi2 !== "100") {
        throw new Error(`确定前复检失败 lo=${lo2}/${lo} hi=${hi2}/${hi} want=${loStr}`);
      }
      const btns = findRef(session, { css: ".pickerPopoverContainer .el-button--primary" });
      if (!btns.length) throw new Error("股息弹层找不到确定按钮");
      clickRef(session, Number(btns[0].ref));
      sleep(450);
      const chipList = chips(session);
      if (hasDividendChip(chipList, loStr)) {
        if (attempt > 1) console.log(`setDividend ok on attempt=${attempt}`);
        return chipList;
      }
      throw new Error(`股息 chip 未落地 want=${loStr}: ${JSON.stringify(chipList)}`);
    } catch (exc) {
      lastErr = exc;
      console.log(`setDividend attempt ${attempt}/${attempts} failed: ${exc.message || exc}`);
      dismissPopover(session);
      sleep(400);
    }
  }
  throw new Error(`setDividend 重试 ${attempts} 次仍失败: ${lastErr?.message || lastErr}`);
}

function currentUrl(session) {
  const raw = evalJs(session, "(function(){return location.href;})()");
  return raw.trim() ? raw.trim().split(/\r?\n/)[0] : "";
}

function clickGoSelect(session) {
  const btns = findRef(session, { css: ".searchBtn" });
  clickRef(session, pickRef(btns, (e) => e.text === "去选股"));
}

function waitResultPage(session, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = currentUrl(session);
    if (url.includes("/Result")) {
      // 等表格行出现
      const n = evalJs(
        session,
        '(function(){var f=document.querySelector(".el-table__fixed-body-wrapper")||document.querySelector(".el-table__fixed .el-table__body");return String(f?f.querySelectorAll("tr").length:0);})()',
      )
        .trim()
        .split(/\r?\n/)
        .pop();
      if (Number(n) > 0) return url;
    }
    sleep(800);
  }
  throw new Error("等待 Result 页/表格超时");
}

function parsePct(raw) {
  if (raw == null || raw === "") return null;
  const m = String(raw)
    .replace(/,/g, "")
    .trim()
    .match(/^([+-]?\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) : null;
}

/** 从 Result 页 el-table 扫出结构化池（固定列 + 滚动列按行对齐） */
function scrapeResultDom(session) {
  const raw = evalJs(
    session,
    `(function(){
  function cells(tr){
    return [].map.call(tr.querySelectorAll("td"), function(td){
      return (td.innerText||"").trim().replace(/\\s+/g," ");
    });
  }
  function headerCells(root){
    if(!root) return [];
    return [].map.call(root.querySelectorAll("th"), function(th){
      return (th.innerText||"").trim().replace(/\\s+/g," ");
    });
  }
  var fixedRoot = document.querySelector(".el-table__fixed-body-wrapper")
    || document.querySelector(".el-table__fixed .el-table__body");
  var bodyRoot = document.querySelector(".el-table__body-wrapper .el-table__body");
  if(!bodyRoot){
    var bodies = document.querySelectorAll(".el-table__body");
    bodyRoot = bodies.length > 1 ? bodies[1] : bodies[0];
  }
  var fixedHead = document.querySelector(".el-table__fixed-header-wrapper")
    || document.querySelector(".el-table__fixed .el-table__header");
  var bodyHead = document.querySelector(".el-table__header-wrapper .el-table__header")
    || document.querySelector(".el-table__header");
  if(!fixedRoot || !bodyRoot){
    return JSON.stringify({ok:false, error:"找不到 el-table 固定列/滚动列"});
  }
  var fixedRows = [].map.call(fixedRoot.querySelectorAll("tr"), cells);
  var bodyRows = [].map.call(bodyRoot.querySelectorAll("tr"), cells);
  var totalHint = null;
  var m = (document.body.innerText||"").match(/共\\s*(\\d+)\\s*只/);
  if(!m) m = (document.body.innerText||"").match(/共[\\s\\u00a0]*([0-9]+)[\\s\\u00a0]*只/);
  if(m) totalHint = Number(m[1]);
  return JSON.stringify({
    ok:true,
    url: location.href,
    headerFixed: headerCells(fixedHead),
    headerBody: headerCells(bodyHead),
    fixedRows: fixedRows,
    bodyRows: bodyRows,
    totalHint: totalHint
  });
})()`,
  );
  const data = parseJsonText(raw);
  if (!data.ok) throw new Error(data.error || "DOM 扫描失败");

  const { fixedRows, bodyRows, headerBody = [], totalHint } = data;
  if (!fixedRows.length) throw new Error("结果表无数据行");
  if (fixedRows.length !== bodyRows.length) {
    throw new Error(
      `固定列/滚动列行数不一致 fixed=${fixedRows.length} body=${bodyRows.length}`,
    );
  }

  // 表头定位股息/市值/PE/PB（滚动区）；代码/名称在固定列固定下标
  const normH = (h) => String(h || "").replace(/\s+/g, "");
  const findCol = (pred) => headerBody.findIndex((h) => pred(normH(h)));
  let divIdx = findCol((h) => h.includes("最新股息率") || h.includes("股息率"));
  let mktIdx = findCol((h) => h.includes("总市值") && !h.includes("流通"));
  let peIdx = findCol((h) => h.includes("市盈率"));
  let pbIdx = findCol((h) => h.includes("市净率"));
  // 兜底：实跑滚动列常见布局 6=股息 7=总市值 ... 15=PE 16=PB
  if (divIdx < 0) divIdx = 6;
  if (mktIdx < 0) mktIdx = 7;
  if (peIdx < 0) peIdx = 15;
  if (pbIdx < 0) pbIdx = 16;

  const pool = [];
  for (let i = 0; i < fixedRows.length; i++) {
    const f = fixedRows[i];
    const b = bodyRows[i] || [];
    const code = String(f[2] || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    let name = String(f[3] || "").replace(/ /g, "").replace(/^(XD|XR|DR)/, "");
    const price = parseYiNumber(f[4]);
    const div = parsePct(b[divIdx]);
    const mktRaw = b[mktIdx];
    const mkt = parseYiNumber(mktRaw); // 元
    let market;
    try {
      market = marketFromCode(code);
    } catch {
      market = null;
    }
    pool.push({
      code,
      name,
      market,
      div,
      mkt,
      mkt_yi: mkt != null ? mkt / 1e8 : null,
      price,
      pb: parseYiNumber(b[pbIdx]),
      pe: parseYiNumber(b[peIdx]),
    });
  }

  if (!pool.length) throw new Error("DOM 扫表未解析出有效代码");

  return {
    source: "xuangu-result-dom",
    url: data.url,
    n: pool.length,
    totalHint,
    headerFixed: data.headerFixed,
    headerBody: data.headerBody,
    colIndex: { div: divIdx, mkt: mktIdx, pe: peIdx, pb: pbIdx },
    pool,
  };
}

function pagerDisabled(entry) {
  const cls = `${entry.class || ""} ${entry.attrs?.class || ""}`;
  if (/disabled|is-disabled/i.test(cls)) return true;
  const aria = entry.attrs?.["aria-disabled"] ?? entry.attrs?.disabled;
  return aria === true || aria === "true";
}

function firstTableCode(session) {
  const raw = evalJs(
    session,
    `(function(){
  var f=document.querySelector(".el-table__fixed-body-wrapper")||document.querySelector(".el-table__fixed .el-table__body");
  var tr=f&&f.querySelector("tr");
  if(!tr) return "";
  var tds=tr.querySelectorAll("td");
  return (tds[2]&&tds[2].innerText||"").trim();
})()`,
  );
  return (raw.trim().split(/\r?\n/).pop() || "").trim();
}

function waitTableCodeChange(session, prevCode, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleep(400);
    const now = firstTableCode(session);
    if (now && now !== prevCode) return now;
  }
  throw new Error(`翻页后表格未变化，首页代码仍为 ${prevCode || "空"}`);
}

function clickNextResultPage(session) {
  const entries = findRef(session, { text: "下一页" });
  let next = null;
  for (const e of entries) {
    if (String(e.text || "").replace(/\s/g, "") === "下一页") {
      next = e;
      break;
    }
  }
  if (!next || pagerDisabled(next)) return false;
  clickRef(session, Number(next.ref));
  return true;
}

function mergePool(base, extra) {
  const seen = new Set(base.map((r) => r.code));
  const out = [...base];
  for (const row of extra) {
    if (!row.code || seen.has(row.code)) continue;
    seen.add(row.code);
    out.push(row);
  }
  return out;
}

function clickCss(session, css, nth = null) {
  const args = ["click", css];
  if (nth != null) args.push("--nth", String(nth));
  const proc = oc(session, args);
  if (proc.returncode !== 0) {
    throw new Error(`click ${css} nth=${nth} failed: ${(proc.stderr || proc.stdout).slice(0, 300)}`);
  }
}

function setResultPageSize(session, size = 100) {
  const nth = { 20: 0, 50: 1, 100: 2, 200: 3 }[size];
  if (nth == null) throw new Error(`不支持的分页大小 ${size}`);
  clickCss(session, ".el-pagination .el-input__inner");
  sleep(400);
  clickCss(session, ".el-select-dropdown__item", nth);
}

function waitRowCountAtLeast(session, want, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = Number(
      evalJs(
        session,
        '(function(){var f=document.querySelector(".el-table__fixed-body-wrapper")||document.querySelector(".el-table__fixed .el-table__body");return String(f?f.querySelectorAll("tr").length:0);})()',
      )
        .trim()
        .split(/\r?\n/)
        .pop(),
    );
    if (n >= want) return n;
    sleep(400);
  }
  throw new Error(`等待表格至少 ${want} 行超时`);
}

function scrapeAllResultPages(session) {
  let scraped = scrapeResultDom(session);
  let pool = scraped.pool;
  const totalHint = scraped.totalHint;
  if (totalHint != null && pool.length === totalHint) {
    return { ...scraped, pool, n: pool.length, pages: 1 };
  }
  if (totalHint != null && totalHint > pool.length) {
    setResultPageSize(session, totalHint > 100 ? 200 : 100);
    waitRowCountAtLeast(session, totalHint);
    scraped = scrapeResultDom(session);
    pool = scraped.pool;
  }
  let pages = 1;
  while (totalHint != null && pool.length < totalHint && pages < 20) {
    const prevCode = pool[0]?.code;
    if (!clickNextResultPage(session)) break;
    waitTableCodeChange(session, prevCode);
    const more = scrapeResultDom(session);
    const before = pool.length;
    pool = mergePool(pool, more.pool);
    pages += 1;
    if (pool.length === before) break;
  }
  if (totalHint != null && pool.length !== totalHint) {
    throw new Error(
      `扫表条数 ${pool.length} ≠ 页内「共${totalHint}只」，可能分页未加载全`,
    );
  }
  return { ...scraped, pool, n: pool.length, pages };
}

function captureResultDom(session, outPath, extra = {}) {
  // 若还在编辑页，点去选股
  if (!currentUrl(session).includes("/Result")) {
    clickGoSelect(session);
  }
  const url = waitResultPage(session);
  const scraped = scrapeAllResultPages(session);
  const payload = {
    ...scraped,
    chips: chips(session),
    fetched_at: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    source: "xuangu-result-dom",
    n: scraped.n,
    url: url || scraped.url,
    chips: payload.chips,
    path: outPath,
    pool: scraped.pool,
    totalHint: scraped.totalHint,
  };
}

function writePool(poolJson, pool, extra = {}) {
  fs.writeFileSync(
    poolJson,
    `${JSON.stringify({ n: pool.length, pool, source_note: "step0-xuangu-result-dom", ...extra }, null, 2)}\n`,
    "utf8",
  );
}

function main() {
  const now = new Date();
  const hhmmss = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      session: `buffett-xg-${hhmmss}`,
      output: buffettTmp("buffett_xuangu_result.json"),
      poolJson: buffettTmp("buffett_pool.json"),
      bondOut: buffettTmp("buffett_bond.json"),
    },
  });
  const session = args.session;
  const outPath = args.output;
  const poolJson = args.poolJson || args["pool-json"];
  const bondOut = args.bondOut || args["bond-out"];

  try {
    const bond = resolveBond(args);
    const floor = step0DivFloor(bond.yield_pct);
    if (bondOut) {
      fs.writeFileSync(bondOut, `${JSON.stringify(bond, null, 2)}\n`, "utf8");
    }
    console.log(
      `bond=${floor.bond}% floor=${floor.loStr}% (国债×2) source=${bond.source || "—"}`,
    );

    console.log(`session=${session}`);
    const proc = oc(session, ["open", "https://xuangu.eastmoney.com/"]);
    if (proc.returncode !== 0) {
      throw new Error((proc.stderr || proc.stdout).slice(0, 400));
    }
    const w = oc(session, ["wait", "text", "条件选股", "--timeout", "20000"], 30_000);
    if (w.returncode !== 0) throw new Error("wait 条件选股 失败");

    clickFundamentalsTab(session);
    setMarketCap(session);
    const c1 = chips(session);
    console.log(`chips_after_mkt=${JSON.stringify(c1)}`);
    if (!c1.some((x) => x.includes("总市值>500亿"))) {
      throw new Error(`市值 chip 不正确: ${JSON.stringify(c1)}`);
    }

    const c2 = setDividend(session, floor.loStr);
    console.log(`chips_final=${JSON.stringify(c2)}`);
    if (!hasDividendChip(c2, floor.loStr)) {
      throw new Error(`股息 chip 不正确 want=${floor.loStr}: ${JSON.stringify(c2)}`);
    }

    console.log("mode=xuangu-result-dom");
    const bondMeta = {
      bond_yield_pct: floor.bond,
      div_floor_pct: floor.lo,
      div_floor_exact: floor.exact,
      bond_source: bond.source || null,
      bond_fetched_at: bond.fetched_at || null,
    };
    const meta = captureResultDom(session, outPath, bondMeta);

    writePool(poolJson, meta.pool, bondMeta);
    console.log(JSON.stringify({
      source: meta.source,
      n: meta.n,
      url: meta.url,
      chips: meta.chips,
      path: meta.path,
      pool: poolJson,
      bond: bondOut,
      ...bondMeta,
    }));
    console.log(`N=${meta.n} SOURCE=${meta.source} POOL=${poolJson} FILE=${outPath}`);
    console.log(`ALL=${meta.pool.map((p) => p.code).join(",")}`);
    return 0;
  } catch (exc) {
    console.error(`error: ${exc.message || exc}`);
    return 1;
  }
}

process.exit(main());
