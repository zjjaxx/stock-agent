# 东方财富数据抓取参考

决策逻辑见 `../SKILL.md`。本文件只保留 URL、字段和脚本用法。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：xuangu 点选 → Result 页 el-table 扫表出池；股息下限=10Y国债×2 |
| `fetch_bond_yield.js` | Investing 中国 10Y 国债收益率 |
| `fetch_dividend_streak.js` | Step1：`DIVIDEND_MAIN` 连续年报分红年限 |
| `fetch_industry.js` | Step1：push2 ulist `f100`（curl 优先，失败则 browser） |
| `industry_map.js` | 行业名 → A–G 画像（`--self-test`）；不打分 |
| `step1_hard_filter.js` | 连续分红 / 股息缺失初筛（市值只在 Step0） |
| `fetch_f10_bundle.js` | Step2：ORG/DUPONT/GCASHFLOW/COMPRE/PROFILE/MAINFINADATA + quote |
| `pack_step2_facts.js` | 合并 Step1+F10 为事实卡（不打分） |
| `red_lines.js` | Step2 红线机械提示（`--self-test`） |
| `fetch_kline_hfq.js` | Step3：后复权 K 线（adapter 优先，失败则 `push2his fqt=2`） |
| `calc_bollinger.js` | Step3：后复权收盘算布林 |
| `fetch_valuation_history.js` | Step3：股息率/PB 历史分位（仅 🟢/🟡） |
| `opencli_json.js` | 公共库，勿当入口 |

```bash
S=scripts
node $S/run_step0_xuangu.js -o /tmp/buffett_xuangu_result.json --pool-json /tmp/buffett_pool.json
# 国债默认写入 /tmp/buffett_bond.json；也可事先 fetch_bond_yield.js 再 --bond-json
node $S/fetch_dividend_streak.js --pool /tmp/buffett_pool.json -o /tmp/buffett_streak.json
node $S/fetch_industry.js --pool /tmp/buffett_pool.json -o /tmp/buffett_industry.json
node $S/step1_hard_filter.js --pool /tmp/buffett_pool.json --streak /tmp/buffett_streak.json \
  --industry /tmp/buffett_industry.json --bond-json /tmp/buffett_bond.json -o /tmp/buffett_step1.json
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("/tmp/buffett_step1.json","utf8"));
fs.writeFileSync("/tmp/buffett_pass_pool.json", JSON.stringify(d.pass,null,2));
'
node $S/fetch_f10_bundle.js --pool /tmp/buffett_pass_pool.json -o /tmp/buffett_f10.json --resume
node $S/pack_step2_facts.js \
  --step1 /tmp/buffett_step1.json --f10 /tmp/buffett_f10.json --bond /tmp/buffett_bond.json \
  -o /tmp/buffett_step2_facts.md --json /tmp/buffett_step2_facts.json
# Agent 按 SKILL Step 2 打分+复核红线；K 线只对 🟢/🟡 再抓
```

## Step 0

入口 `https://xuangu.eastmoney.com/`。**唯一出池路径**是跑 `run_step0_xuangu.js`（不要手点、不要 `search-code`、不要 yjfp）。

脚本会：切「基本面」→ 总市值 `>1000亿` → 最新股息率自定义 `[国债×2, 100]`（fill 后必须 get value 验收，上限勿被默认成 5）→ 点「去选股」→ 扫 Result 页 el-table。

DOM 口径：固定列（序号/代码/名称/最新价）与滚动列（股息/总市值/PE/PB）**按行对齐**；解析 N 必须等于页内「共 N 只」；来源 `xuangu-result-dom`。N 随国债与行情变，勿拿历史条数当金标准。

失败则整 skill 终止（模板见主 skill Step 0）。禁止改走 yjfp / 行业表 / 记忆凑池。

## 个股字段

执行前 `opencli doctor`。示例 `600900` 须按标的替换 code / 交易所前缀 / 简称。有 adapter 先用 adapter；F10 财务报表走 browser network。

### 现价 / 市值 / PE / PB

```bash
opencli eastmoney quote 600900 -f json
# price, marketCap, peDynamic, priceBook, name, market
```

### F10（browser + reportName）

```
BASE=https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code=SH600900
```

| hash | reportName / type | 用途 |
|---|---|---|
| `#/fhrz` | `RPT_F10_DIVIDEND_MAIN` / `COMPRE` / `DIVIDENDNEW_PROFILE` | 连续分红、年度分红总额、派息摘要 |
| `#/gsgk` | `RPT_F10_ORG_BASICINFO` | `REAL_CONTROLER` / `CONTROL_HOLDER` / `ORG_FORM`（概念标签≠性质终审） |
| `#/cwfx` | `MAINFINADATA` / `DUPONT` / `GCASHFLOW` | ROE、净利、净现比、现金流、资本开支、银行/保险专项 |

认 key：用 URL 里 `reportName=` / `type=` 匹配，取 size 最大的再 `--detail`。禁止写死 `#N`。`cache_expired` 时换 session 或加 `--ttl`。

```
FCF = NETCASH_OPERATE − CONSTRUCT_LONG_ASSET
覆盖率 = FCF / 该年 TOTAL_DIVIDEND
```

`DIVIDEND_PAY_RATIO` 是小数比（0.55=55%，2.235=223.5%），须 ×100；>1 时勿当「百分之几」原样写入。

### 布林（必须后复权）

禁止省略 `--adjust backward`；禁止用行情页默认 `fqt=1`。后复权 close 与 `quote.price` 数量级不同属正常。

```bash
node ../scripts/fetch_kline_hfq.js 600900 --period day -o /tmp/600900_day.json
node ../scripts/calc_bollinger.js /tmp/600900_day.json
node ../scripts/calc_bollinger.js /tmp/600900_week.json --period W
node ../scripts/calc_bollinger.js /tmp/600900_month.json --period M
# adapter 失败自动改 push2his fqt=2；强制备援加 --browser-only
```

报告「K 线数据来源」写 `东财 kline --adjust backward` 或 `东财 push2his fqt=2（browser 直开）`。

### 估值分位（Step 3.3）

`fetch_valuation_history.js`：`RPT_VALUEANALYSIS_DET`（收盘/PB）× `DIVIDEND_MAIN`（现金分红，含「特别」跳过）→ 近 5 年 TTM 股息率分位 + PB 分位。

分批 ≤5% 硬条件：股息率分位 ≥80；无股息分位时 PB 分位 ≤20。冲突以股息率分位为准。算不出则观望。

```bash
node ../scripts/fetch_valuation_history.js 600900.SH -o /tmp/600900_val.json
```

### 10Y 国债

默认 Investing `https://cn.investing.com/rates-bonds/china-10-year-bond-yield`。东财 `zgzmcbysyl.html` 常废页，不要当默认源。

```bash
node ../scripts/fetch_bond_yield.js -o /tmp/buffett_bond.json
```

Step 0 用 `最新股息率 ≥ 国债×2`；Step 1 只把 `bond_ratio` 写入结果，不再用倍数做门槛。

## 字段映射

| 评估字段 | 来源 |
|---|---|
| Step 0 候选 | Result 页 el-table（`xuangu-result-dom`） |
| 行业 A–G | `fetch_industry.js` 的 `f100` → `industry_map.js`。禁止代码名单或简称包含 |
| 现价/市值/PE/PB | `eastmoney quote` |
| TTM 股息率 | 初筛：Result「最新股息率」；个股：PROFILE.`DIVIDEND_NEWRATIO` |
| 派息率 | 优先 PROFILE.`DIVIDEND_PAY_RATIO`（×100）；哨兵触发则同年 COMPRE÷净利 |
| ROE(3 年) | `MAINFINADATA.ROEJQ` 或 `DUPONT.ROE`（年报） |
| 经营现金流 / 净现比 | `GCASHFLOW.NETCASH_OPERATE` / `MAINFINADATA.NCO_NETPROFIT` |
| 资本开支 | `GCASHFLOW.CONSTRUCT_LONG_ASSET` |
| 年度分红 | `DIVIDEND_COMPRE.TOTAL_DIVIDEND` |
| 负债率 | `DUPONT.DEBT_ASSET_RATIO`（银行/保险不用） |
| 银行专项 | `NONPERLOAN` / `BLDKBBL` / `HXYJBCZL` / `NET_INTEREST_MARGIN` |
| 保险专项 | `SOLVENCY_AR` / `NET_ROI` |
| 企业性质 | `REAL_CONTROLER`（主）+ `CONTROL_HOLDER` / `ORG_FORM` |
| 连续分红 | `DIVIDEND_MAIN` 按年去重 |
| 估值分位 | `fetch_valuation_history.js` |
| 布林 | `kline --adjust backward` 或 `push2his fqt=2` + `calc_bollinger.js` |
| 10Y 国债 | Investing（默认） |

## 派息率哨兵

1. 优先 PROFILE：小数比 ×100；禁止把 2.235 写成 2.24%
2. 无 PROFILE，或 PROFILE 踩哨兵且 COMPRE 自算更干净 → 同年 `TOTAL_DIVIDEND ÷ PARENT_NETPROFIT`
3. 哨兵：派息 <10% 且 TTM 股息≥3.5% 且 PB≤5；或 股息率 ≈ 派息×ROE/PB 数量级差 ≥3 倍
4. |PROFILE − COMPRE| >15pct 记入 reasons，仍以 PROFILE 为准
5. 采用 PROFILE 时，同年 FCF 分红总额用「净利×PROFILE 派息」回填
6. 仍失败标「派息率数据缺口」；>100% 走红线

## 抓取原则

1. Prefer adapter / network JSON；F10 认 `reportName`/`type`，不认写死 `#N`
2. eval 只读；禁止用 eval 改 DOM/导航（hash `open` 除外）
3. Step 0 只走 Result 页对齐扫表。禁止 yjfp / 行业表 / 记忆 / search-code
4. 关键 network 包同一回合立刻 `--detail` 落盘
5. 财务数字写明报告期；个股失败可换入口或向用户索要（仅 Step 0 成功后）；禁止编造
6. 布林必须后复权；与现价勿直接比绝对价位
7. 国债默认 Investing；东财国债废页跳过
