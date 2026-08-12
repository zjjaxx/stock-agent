# 东方财富数据抓取参考

主 skill 决策逻辑见 `../SKILL.md`。需要具体 URL、字段来源或 opencli 命令时再读本文件。

## 固化脚本（`../scripts/`，本轮实跑验收）

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：点选 xuangu → Result 页 el-table 扫表出池（`xuangu-result-dom`） |
| `fetch_bond_yield.js` | Step1：Investing 中国10Y 国债收益率 |
| `fetch_dividend_streak.js` | Step1：`DIVIDEND_MAIN` 连续年报分红年限 |
| `step1_hard_filter.js` | Step1：市值/行业股息基准/连续分红/国债比初筛 |
| `fetch_f10_bundle.js` | Step2：ORG/DUPONT/GCASHFLOW/COMPRE/PROFILE/**MAINFINADATA** + quote |
| `fetch_kline_hfq.js` | Step4：后复权 K 线（adapter 优先，失败则 browser `push2his fqt=2`） |
| `calc_bollinger.js` | Step4：后复权收盘算布林 |
| `score_and_report.js` | 简化评分 + 布林 + 落盘桌面报告 |
| `opencli_json.js` | 公共库（勿单独当入口） |

典型串联：

```bash
S=scripts
node $S/run_step0_xuangu.js -o /tmp/buffett_xuangu_result.json --pool-json /tmp/buffett_pool.json
node $S/fetch_bond_yield.js -o /tmp/buffett_bond.json
node $S/fetch_dividend_streak.js --pool /tmp/buffett_pool.json \
  --bond "$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/buffett_bond.json","utf8")).yield_pct)')" \
  -o /tmp/buffett_streak.json
node $S/step1_hard_filter.js --pool /tmp/buffett_pool.json --streak /tmp/buffett_streak.json \
  --bond-json /tmp/buffett_bond.json -o /tmp/buffett_step1.json
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("/tmp/buffett_step1.json","utf8"));
fs.writeFileSync("/tmp/buffett_pass_pool.json", JSON.stringify(d.pass,null,2));
console.log("pass", d.pass.length);
'
node $S/fetch_f10_bundle.js --pool /tmp/buffett_pass_pool.json -o /tmp/buffett_f10.json --resume
node $S/score_and_report.js \
  --step1 /tmp/buffett_step1.json --f10 /tmp/buffett_f10.json --bond /tmp/buffett_bond.json
```

## Step 0：条件选股构建动态候选池（强制）

**入口**：`https://xuangu.eastmoney.com/`（条件选股）  
**目的**：现场查出当日池，禁止用 `SKILL.md` 行业表示例名单顶替。

### 推荐操作流（opencli-browser）

**唯一路径：基本面结构化点选**。会话名固定用 `buffett-xuangu`。  
**禁止**把下列命令里的数字 ref 当死值复用——每次都要先 `find`/`state` 再 `click`（ref 随会话变化）。

#### 0. 打开页面

```bash
opencli doctor
opencli browser buffett-xuangu open "https://xuangu.eastmoney.com/"
opencli browser buffett-xuangu wait text "条件选股"
```

#### 1. 切到「基本面」

```bash
opencli browser buffett-xuangu find --text "基本面"
# 点 role=tab / id=tab-基本面 的那一项（不要点整个 tablist）
opencli browser buffett-xuangu click <基本面-tab-ref>
```

#### 2. 总市值 → 预设 `>1000亿`（本框架市值硬门槛）

```bash
# 打开「总市值」气泡（find 可能标 visible:false，仍可 click）
opencli browser buffett-xuangu find --css ".listItem.main-item"
opencli browser buffett-xuangu click <总市值-ref>   # text=="总市值"

# 在打开的 popover 里选预设（比「自定义」对话框更稳）
opencli browser buffett-xuangu find --css ".pickerPopoverContainer .listItem"
opencli browser buffett-xuangu click <ref>          # text==">1000亿"
opencli browser buffett-xuangu find --css ".pickerPopoverContainer .el-button--primary"
opencli browser buffett-xuangu click <确定-ref>

# 验收：上方筛选 chip 出现「总市值>1000亿」
opencli browser buffett-xuangu eval '(function(){return JSON.stringify([].map.call(document.querySelectorAll(".index-tag"),function(e){return e.textContent.trim();}));})()'
```

#### 3. 最新股息率 → 自定义下限 3.5%（默认=股息率 TTM）

气泡预设只有 `>3%` / `>5%`，**没有 3.5%**。要用自定义双输入框：

```bash
opencli browser buffett-xuangu find --css ".listItem.main-item"
opencli browser buffett-xuangu click <最新股息率-ref>   # text=="最新股息率"

opencli browser buffett-xuangu find --css ".pickerPopoverContainer .el-input__inner"
# 两个 spinbutton：第 0 个=下限，第 1 个=上限
# ⚠️ 只填下限时，上限常被默认成 5，chip 会变成「3.5%-5%」（错误过窄）
opencli browser buffett-xuangu fill <下限-ref> "3.5"
opencli browser buffett-xuangu fill <上限-ref> "100"    # 近似 ≥3.5%
opencli browser buffett-xuangu get value <下限-ref>      # 必须=3.5
opencli browser buffett-xuangu get value <上限-ref>      # 必须=100（防默认上限 5）
# 脚本 `run_step0_xuangu.js` 已固化：fill→get value 校验→确定前复检→chip 验收，失败整段最多重试 3 次

opencli browser buffett-xuangu find --css ".pickerPopoverContainer .el-button--primary"
opencli browser buffett-xuangu click <确定-ref>

# 验收 chip ≈ 「最新股息率3.5%-100%」
opencli browser buffett-xuangu eval '(function(){return JSON.stringify([].map.call(document.querySelectorAll(".index-tag"),function(e){return e.textContent.trim();}));})()'
```

快捷替代（条件更松，须在报告注明）：直接点预设 `>3%`，跳过自定义。

#### 4. 提交选股并出池（脚本扫 Result 页 DOM）

条件 chip 齐了还不够，必须点 **「去选股」** 进入 `/Result?...`，再扫 `el-table`。

**推荐直接跑脚本**（唯一出池路径）：

```bash
node ../scripts/run_step0_xuangu.js \
  -o /tmp/buffett_xuangu_result.json --pool-json /tmp/buffett_pool.json
```

**DOM 扫表口径**：Result 页 Element UI 表分固定列 + 滚动列，必须按行对齐：
- 固定列：`序号 / 代码 / 名称 / 最新价 / 涨跌幅`
- 滚动列：按表头定位 `最新股息率 / 总市值 / 市盈率(动) / 市净率`（勿盲取 fixed 列错位字段）
- 验收：解析出的 N == 页内「共 N 只」
- 来源标注：`xuangu-result-dom`
- 验收样例（2026-08-07/08）：chip=`总市值>1000亿`+`最新股息率3.5%-100%` → N=**51**；首条多见 `000651 格力电器`

报告 Step 0 必须写明：筛条件 chip、抓取时点、**落盘路径与来源**（`xuangu-result-dom`）、条数 N、**完整**代码列表。  
池全量进入主 skill Step 1；过硬门槛的 M 只全部做后续深度分析。

**坑**：
- DOM 扫表若只读滚动区、或固定列/滚动列错位对齐 → 市值会错配（历史事故）
- 分页未加载全却假装全量 → 条数对不上「共 N 只」应判失败
- 概念/风格弹层打开时，部分控件几何尺寸为 0；卡住就 `open` 重载，或 Esc 关掉弹层

#### 坑与禁区

- ❌ 自然语言框（「一句话包含多指标」）对 agent 解析不稳定，**不要当主路径**
- ❌ `opencli browser ... click --role button --name 确定` 会命中页面里几百个「确定」→ 必须先限定在 `.pickerPopoverContainer`
- ❌ 概念/风格弹层打开时，部分控件几何尺寸为 0；卡住就 `open` 重载，或 Esc 关掉弹层
- ❌ DOM 扫表若只读滚动区、或固定列/滚动列错位对齐 → 市值会错配
- ❌ 禁止再走 network `search-code` 出池（接口不稳定，已从脚本移除）
- 可选：`范围`→概念勾选「中特估」「央企改革」仅作召回优先（非强制；≠企业性质终审）

### DOM 出池验收

到达 `/Result?...`、chip 正确后，`run_step0_xuangu.js` 扫 `el-table`：
- **必须**固定列（代码/名称/价）与滚动列（股息/总市值/PE/PB）**同行对齐**
- **必须** `parsed N === 页内「共 N 只」`
- 报告注明来源 `xuangu-result-dom`

仍禁止：yjfp 分红榜、行业表示例、凭记忆凑池、分页未加载全却假装全量。

### 失败处理

判定失败（任一即可）：
- 无法打开/操作 `https://xuangu.eastmoney.com/`
- 无法形成有效筛条件或结果为空/不可信
- Result DOM 扫表失败（或条数对不上「共 N 只」）

终止输出模板见主 skill Step 0「Step 0 失败 = 立即终止」。

---

## 个股深度字段：可执行抓取（2026-08-07 实跑验收）

执行前：`opencli doctor`。会话名按用途分开：`buffett-quote` / `buffett-f10`（**必须**带 session；旧写法 `opencli browser tab new` 已不适用）。

> 示例：`600900 长江电力`。替换时改：
> - 6 位代码、交易所前缀（沪 `sh`/`SH`，深 `sz`/`SZ`，北 `bj`/`BJ`）
> - `SECUCODE` 形如 `600900.SH`
> - `wait text` 用公司简称

**优先级**：有 site adapter 先用 adapter；F10 财务报表仍走 browser network。

### A. 现价 / 市值 / PE / PB（优先 adapter）

```bash
opencli eastmoney quote 600900 -f json
# 字段：price, marketCap, floatMarketCap, peDynamic, priceBook, name, market
```

验收样例（2026-08-07）：`price=27.75`，`peDynamic=25.11`，`priceBook=3.26`，`marketCap≈6.79e11`。

备选（browser）：

```bash
opencli browser buffett-quote open "https://quote.eastmoney.com/sh600900.html"
opencli browser buffett-quote wait text "长江电力"
opencli browser buffett-quote network
# key：GET push2.eastmoney.com/api/qt/stock/get（body 为 jQuery 回调包一层 JSON）
# 不如 adapter 好用——默认仍用 quote
```

### B. F10：分红 / 企业性质 / 财务（browser + reportName）

直接用 hash 打开子页（比点侧栏稳）：

| 子页 | URL hash | 用途 |
|---|---|---|
| 分红融资 | `#/fhrz` | 分红历史、派息摘要、年度分红 |
| 公司概况 | `#/gsgk` | 实际控制人 / 企业性质 |
| 财务分析 | `#/cwfx` | 主要指标、杜邦、三表 |

```bash
BASE='https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code=SH600900'

# --- B1 分红融资 ---
opencli browser buffett-f10 open "${BASE}#/fhrz"
sleep 3
opencli browser buffett-f10 network --ttl 172800000
# 按 URL query 的 reportName / type 认 key（#N 后缀每次变，禁止写死）：
#   RPT_F10_DIVIDEND_MAIN          历史分红表（连续分红年限、实施方案）
#   RPT_F10_DIVIDEND_COMPRE        分年 TOTAL_DIVIDEND（年度分红总额）
#   RPT_F10_DIVIDENDNEW_PROFILE    DIVIDEND_NEWRATIO / DIVIDEND_PAY_RATIO 等摘要
opencli browser buffett-f10 network --detail "<匹配到的 key>" > /tmp/f10_div_main.json

# --- B2 公司概况 ---
opencli browser buffett-f10 open "${BASE}#/gsgk"
sleep 3
opencli browser buffett-f10 network --ttl 172800000
#   RPT_F10_ORG_BASICINFO
#     REAL_CONTROLER=实际控制人（例：国务院国有资产监督管理委员会）
#     CONTROL_HOLDER=控股股东（例：中国长江三峡集团有限公司）
#     ORG_FORM=组织形态（例：央企子公司）；BLGAINIAN=概念（≠企业性质终审）

# --- B3 财务分析（主要指标 + 三表同页一次加载） ---
opencli browser buffett-f10 open "${BASE}#/cwfx"
sleep 3
opencli browser buffett-f10 network --ttl 172800000
# URL 里 type= 或 reportName=（/api/data/get 用 type，/v1/get 用 reportName）：
#   RPT_F10_FINANCE_MAINFINADATA  主要指标：ROEJQ、PARENTNETPROFIT、NCO_NETPROFIT、MGJYXJJE…
#   RPT_F10_FINANCE_DUPONT        杜邦：ROE、PARENT_NETPROFIT、DEBT_ASSET_RATIO
#   RPT_F10_FINANCE_GCASHFLOW     现金流量表：NETCASH_OPERATE、CONSTRUCT_LONG_ASSET
#   RPT_F10_FINANCE_GBALANCE      资产负债表：TOTAL_ASSETS、TOTAL_LIABILITIES
#   RPT_F10_FINANCE_GINCOME       利润表（备用）
```

**认 key 小技巧**：`network` 列出后，用 URL 里 `reportName=` / `type=` 匹配，取 **size 最大** 的那条再 `--detail`。`cache_expired` 时换新 session 名或先 `network --ttl 172800000` 再立刻 detail（不要复用隔夜旧 `#N`）。

**FCF（非银行）**：

```
FCF = NETCASH_OPERATE − CONSTRUCT_LONG_ASSET
# CONSTRUCT_LONG_ASSET =「购建固定资产、无形资产和其他长期资产支付的现金」
# 覆盖率 = FCF / 该年 TOTAL_DIVIDEND（来自 DIVIDEND_COMPRE 或 MAIN 合计）
```

验收样例（长江电力 2025 年报口径，2026-08-07 抓）：

| 字段 | 值 |
|---|---|
| `ROEJQ` / `ROE` | 15.9 |
| `PARENTNETPROFIT` | ≈345.0 亿 |
| `NETCASH_OPERATE` | ≈605.6 亿 |
| `CONSTRUCT_LONG_ASSET` | ≈184.9 亿 |
| `TOTAL_DIVIDEND`(2025) | ≈244.7 亿 |
| `REAL_CONTROLER` | 国务院国有资产监督管理委员会 |
| `DIVIDEND_PAY_RATIO`（PROFILE） | **小数比**（0.55=55%，2.235=223.5%），脚本须 `×100` 成百分数；>1 时勿当「百分之几」原样写入。**派息默认优先此字段**；COMPRE 自算作备援 |

### C. 布林带（后复权 kline + 自算）

**必须 `fqt=2`（后复权）**。禁止用行情页默认抓到的 `fqt=1`（前复权）算布林。

| 优先级 | 路径 | 何时用 | 报告「K 线数据来源」写法 |
|---|---|---|---|
| **1** | `opencli eastmoney kline ... --adjust backward` | 日常默认 | `东财 kline --adjust backward` |
| **2** | browser **直开** `push2his` URL（显式 `fqt=2`）→ 读 `body.innerText` / JSON → 转 date/close → `calc_bollinger.js` | adapter DNS/代理失败，或行情页 network 只有 `fqt=1` | `东财 push2his fqt=2（browser 直开）` |
| 3 | 向用户索要后复权收盘序列 | 1+2 都失败 | 用户提供 |

```bash
# —— 路径 1：adapter（优先）——
opencli eastmoney kline 600900 --period day --adjust backward --limit 520 -f json > /tmp/600900_day.json

# —— 路径 2：脚本（adapter 失败自动改 push2his fqt=2）——
node ../scripts/fetch_kline_hfq.js 600900 --period day -o /tmp/600900_day.json
node ../scripts/fetch_kline_hfq.js 600900 --period week -o /tmp/600900_week.json
node ../scripts/fetch_kline_hfq.js 600900 --period month -o /tmp/600900_month.json
# 强制备援：加 --browser-only

node ../scripts/calc_bollinger.js /tmp/600900_day.json
node ../scripts/calc_bollinger.js /tmp/600900_week.json --period W
node ../scripts/calc_bollinger.js /tmp/600900_month.json --period M
```

**强制 / 禁区**：
- ❌ 省略 `--adjust backward`（adapter 默认 forward）
- ❌ 打开 `quote.eastmoney.com/...` 后抓 network 里的 kline 却不核 `fqt`——行情页默认常是 **`fqt=1` 前复权**，**不得**用于布林
- ❌ shell/curl 直打 push2his 若遇 DNS/代理失败，改走路径 2，不要改用前复权凑合
- ❌ 手抄网页布林；未确认 `fqt=2` / `--adjust backward` 禁止用于布林
- 后复权 close（例 ~69）与 `quote.price`（例 ~27.75）数量级不同属正常

验收样例（2026-08-07）：日线 `sample_count=520`，`bandwidth_pct≈6.21`；周/月亦可算通。

### C2. 估值分位（近 5 年 TTM 股息率 + PB；Step 4.3）

技术位未满足 / 布林失效时，才允许用估值分位做**少量**布局。脚本：[`scripts/fetch_valuation_history.js`](../scripts/fetch_valuation_history.js)。

| 序列 | 来源 | 算法 |
|---|---|---|
| 日频收盘 / PB | `RPT_VALUEANALYSIS_DET`（datacenter-web）`CLOSE_PRICE` / `PB_MRQ` | 近 5 年（pageSize≈1400） |
| 现金分红事件 | `RPT_F10_DIVIDEND_MAIN`：除权日 + 解析「10派X元」 | 方案文案含「特别/特殊」跳过 |
| TTM 股息率 | 过去 365 日每股现金分红合计 ÷ 当日 `CLOSE_PRICE` | 对全样本算分位 |
| PB 分位 | 当日 `PB_MRQ` 在近 5 年 PB 序列中的分位 | 交叉验证 |

**允许「分批≤5%」硬条件**（冲突以股息率分位为准）：
- 有股息率分位 → **≥80** 才允许分批；否则动作必须是**观望**
- 无股息率分位、仅有 PB → **PB 分位 ≤20** 才允许分批

```bash
node ../scripts/fetch_valuation_history.js 600900.SH -o /tmp/600900_val.json
# 字段：div_pctile / pb_pctile / allow_batch / div_yield_now / pb_now / years
```

报告必填：股息率分位 / PB 分位；禁止未计算就写「估值分位」并给分批仓位。

### D. 10 年期国债收益率（Step 1 股息/国债比）

东财宏观页 `https://data.eastmoney.com/cjsj/zgzmcbysyl.html` **browser 实跑常废页**（标题 `undefined`、正文几乎无收益率；`--filter EM_BOND` 也滤空）。**不要再把它当默认固化源**。

| 优先级 | 路径 | 报告出处写法 |
|---|---|---|
| **1（默认）** | browser 打开 Investing 中国 10 年期国债收益率页 → `eval` 读当前收益率文本 | `Investing.com 中国10Y 国债收益率` |
| 2 | 用户粘贴当日 10Y 收益率 | `用户提供` |
| — | ~~东财 zgzmcbysyl.html~~ | 仅当页面实际含可用数字时才可采用；废页则跳过 |

```bash
node ../scripts/fetch_bond_yield.js -o /tmp/buffett_bond.json
# 字段：yield_pct / source / url / fetched_at
```

Step 1 硬门槛 `TTM股息率 / 10Y国债收益率 > 1.5` 使用此值；禁止凭记忆填国债收益率。

## 东方财富入口 URL

| 数据类型 | URL / 命令 |
|---|---|
| **条件选股（Step 0）** | `https://xuangu.eastmoney.com/` |
| 现价估值（优先） | `opencli eastmoney quote <code>` |
| 个股行情页（备选） | `https://quote.eastmoney.com/{sh\|sz\|bj}{code}.html` |
| F10 资料 | `https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code={SH\|SZ\|BJ}{code}` + `#/fhrz`/`#/gsgk`/`#/cwfx` |
| 后复权 K 线（优先） | `opencli eastmoney kline <code> --adjust backward` |
| 后复权 K 线（备援） | browser 直开 `push2his.../kline/get?...&fqt=2&klt={101\|102\|103}&lmt=...` |
| **估值分位（Step 4.3）** | `node scripts/fetch_valuation_history.js`：`RPT_VALUEANALYSIS_DET` + `DIVIDEND_MAIN` |
| 估值分析页（人工核） | `https://data.eastmoney.com/gzfx/detail/{code}.html` |
| 10Y 国债收益率（默认） | Investing：`https://cn.investing.com/rates-bonds/china-10-year-bond-yield` |
| 东财国债页（易废页） | `https://data.eastmoney.com/cjsj/zgzmcbysyl.html`（**非默认**；废页跳过） |
| 分红配送榜 | `https://data.eastmoney.com/yjfp/`（**不是 Step 0 回退**） |
| 公司公告 | `opencli eastmoney announcement` |

## 字段映射（以实跑路径为准）

| 评估字段 | 优先来源与字段 |
|---|---|
| Step 0 候选列表 | Result 页 el-table（`xuangu-result-dom`）：固定列代码/名称 + 滚动列股息/市值 |
| 当前价/总市值 | `eastmoney quote` → `price` / `marketCap` |
| PE(动态)/PB | `quote` → `peDynamic` / `priceBook` |
| TTM股息率 | 初筛：Result 表「最新股息率」列；个股：`RPT_F10_DIVIDENDNEW_PROFILE.DIVIDEND_NEWRATIO`（滚动口径，剔特别分红须人工核对） |
| 派息率 | **优先** PROFILE.`DIVIDEND_PAY_RATIO`（×100）；无 PROFILE / PROFILE 踩哨兵时改同年自算 `TOTAL_DIVIDEND÷PARENTNETPROFIT`。**必须过哨兵** |
| ROE(近3年) | `MAINFINADATA.ROEJQ` 或 `DUPONT.ROE`（取年报） |
| 经营现金流 | `GCASHFLOW.NETCASH_OPERATE` |
| 资本开支 | `GCASHFLOW.CONSTRUCT_LONG_ASSET` |
| 年度分红总额 | `DIVIDEND_COMPRE.TOTAL_DIVIDEND`（按 `STATISTICS_YEAR`） |
| 资产负债率 | `DUPONT.DEBT_ASSET_RATIO` 或 `GBALANCE.TOTAL_LIABILITIES/TOTAL_ASSETS`（银行/保险不适用通用表） |
| 银行专项（不良率/拨备/核充/净息差） | `MAINFINADATA`：`NONPERLOAN` / `BLDKBBL` / `HXYJBCZL` / `NET_INTEREST_MARGIN`（年报）；**必须实数打分，禁止占位** |
| 保险专项（偿付/投资收益） | `MAINFINADATA`：`SOLVENCY_AR` / `NET_ROI`；E类保险用保险专用表 |
| 企业性质 | `ORG_BASICINFO.REAL_CONTROLER`（主）+ `CONTROL_HOLDER` / `ORG_FORM`；概念标签≠终审 |
| 连续分红年限 | `DIVIDEND_MAIN` 历史表按年去重计数 |
| 估值分位（股息率/PB） | `fetch_valuation_history.js`：`VALUEANALYSIS_DET`×`DIVIDEND_MAIN`；分批仅股息率分位≥80（或无股息分位时PB≤20） |
| 布林带 | `kline --adjust backward` 或 `push2his fqt=2` + `calc_bollinger.js` |
| 10Y 国债收益率 | Investing 中国 10Y（默认）；用户粘贴（备选）；东财国债页仅非废页时 |

## 派息率抓取与校验（强制）

```
1. F10 #/fhrz → RPT_F10_DIVIDEND_COMPRE / PROFILE + DUPONT（脚本：fetch_f10_bundle.js）
2. **优先 PROFILE**：`DIVIDEND_PAY_RATIO` 为小数比（0.55=55%），须 ×100；禁止把 2.235 写成 2.24%
3. **备援自算**：无 PROFILE，或 PROFILE 踩哨兵且 COMPRE 自算更干净 → 同年 COMPRE.TOTAL_DIVIDEND ÷ DUPONT.PARENT_NETPROFIT
4. PROFILE 哨兵（踩则尝试改自算）：
   - 高息低派息：派息 <10% 且 TTM股息≥3.5% 且 PB≤5
   - 粗验：股息率 ≈ 派息×ROE/PB，数量级差 ≥3 倍
5. |PROFILE − COMPRE| > 15pct：记入 reasons（如平安曾差≈14.9pct 未触发旧「>15才回落」盲区）；仍以 PROFILE 为准
6. 采用 PROFILE 时，同年 FCF 分红总额用「净利×PROFILE派息」回填，避免覆盖率被残缺 COMPRE 放大
7. 仍失败则标注「派息率数据缺口」，禁止凑数；>100% 由评分红线处理（如五粮液 2025）
```

## 抓取原则

1. **Prefer adapter / network JSON over DOM**；F10 认 `reportName`/`type`，不认写死 `#N`
2. **eval 只读**：禁止用 eval 改 DOM/导航（hash `open` 除外）
3. **Step 0** 唯一路径：Result 页对齐扫表（`xuangu-result-dom`）。禁止 yjfp/行业表/凭记忆凑池；禁止依赖 search-code
4. **关键 network 包同一回合立刻 `--detail` 落盘**（配合 `--ttl`）；禁止隔多轮再取
5. **时效**：财务数字写明报告期；过季重抓
6. **失败**：个股字段失败可换备选入口或向用户索要（仅 Step 0 成功后）；禁止编造
7. **复权**：布林必须后复权（`fqt=2` / `--adjust backward`）；禁止行情页默认 `fqt=1`；与现价勿直接比绝对价位
8. **国债**：默认 Investing；东财 `zgzmcbysyl` 废页时跳过，勿空转
9. **概念软预筛**≠企业性质终审
