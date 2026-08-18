# 东方财富数据抓取参考

决策逻辑与每步默认 **Run** 见 `../SKILL.md`。本文件只保留 URL、字段、flags 和完整串联。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：xuangu 点选 → Result 页 el-table 扫表出池；股息下限=10Y国债×2 |
| `fetch_bond_yield.js` | Investing 中国 10Y 国债收益率 |
| `fetch_dividend_streak.js` | Step1：`DIVIDEND_MAIN` 连续年报分红年限 |
| `fetch_industry.js` | Step1：push2 ulist `f100`（curl 优先，失败则 browser） |
| `step1_hard_filter.js` | 连续分红 / 股息缺失初筛（市值只在 Step0）；`--pass-json` 写出通过池 |
| `fetch_f10_bundle.js` | Step2：ORG/DUPONT/GCASHFLOW/COMPRE/PROFILE/MAINFINADATA + quote；含 DPS/派息历史与 5 年持久性数据 |
| `pack_step2_facts.js` | 合并 Step1+F10 为事实卡，并写入全量数字评分与总分 |
| `score_numeric.js` | 同类分位 + 已批准长期锚 + 自身历史 + 持久性，全量数字评分（`--self-test`） |
| `build_anchor_pool.js` | 低频校准：按 f100 取总市值靠前样本；默认排除未明确映射的 G 类 |
| `calibrate_anchors.js` | 低频校准：近 10 年公司中位 → 行业横截面锚，支持 `--resume`；产出 candidate 与复核报告 |
| `approve_anchors.js` | 人工复核后将 candidate 写入 `anchors.approved.json`；无 `--yes` 仅预览 |
| `red_lines.js` | Step2 红线机械提示 hard/soft（`--self-test`）；特别分红走 soft |
| `fetch_kline_hfq.js` | Step3：后复权 K 线（adapter 优先，失败则 `push2his fqt=2`） |
| `calc_bollinger.js` | Step3：后复权收盘算布林（唯一买卖路径） |
| `fetch_valuation_history.js` | **已退出买卖流程**；可选研究用，禁止据此给仓位 |
| `opencli_json.js` | 公共库，勿当入口 |

```bash
S=scripts
node $S/run_step0_xuangu.js -o ~/Desktop/temp/buffett_xuangu_result.json --pool-json ~/Desktop/temp/buffett_pool.json
# 国债默认写入 ~/Desktop/temp/buffett_bond.json；也可事先 fetch_bond_yield.js 再 --bond-json
node $S/fetch_dividend_streak.js --pool ~/Desktop/temp/buffett_pool.json -o ~/Desktop/temp/buffett_streak.json
node $S/fetch_industry.js --pool ~/Desktop/temp/buffett_pool.json -o ~/Desktop/temp/buffett_industry.json
node $S/step1_hard_filter.js --pool ~/Desktop/temp/buffett_pool.json --streak ~/Desktop/temp/buffett_streak.json \
  --industry ~/Desktop/temp/buffett_industry.json --bond-json ~/Desktop/temp/buffett_bond.json \
  -o ~/Desktop/temp/buffett_step1.json --pass-json ~/Desktop/temp/buffett_pass_pool.json
node $S/fetch_f10_bundle.js --pool ~/Desktop/temp/buffett_pass_pool.json -o ~/Desktop/temp/buffett_f10.json --resume
node $S/pack_step2_facts.js \
  --step1 ~/Desktop/temp/buffett_step1.json --f10 ~/Desktop/temp/buffett_f10.json --bond ~/Desktop/temp/buffett_bond.json \
  -o ~/Desktop/temp/buffett_step2_facts.md --json ~/Desktop/temp/buffett_step2_facts.json
# Agent 复核红线；总分直接取事实卡脚本结果；K 线只对 🟢/🟡 再抓；勿跑估值分位脚本做买卖
```

### 长期锚校准（建议年度更新，不进入日常链路）

```bash
node $S/build_anchor_pool.js -o ~/Desktop/temp/buffett_anchor_pool.json
node $S/calibrate_anchors.js --pool ~/Desktop/temp/buffett_anchor_pool.json --resume
# 先读桌面 buffett-anchor-report-YYYYMMDD.md，再预览并审批：
node $S/approve_anchors.js --candidate ~/Desktop/temp/buffett_anchors_candidate_YYYYMMDD.json
node $S/approve_anchors.js --candidate ~/Desktop/temp/buffett_anchors_candidate_YYYYMMDD.json --yes
```

口径：每家公司至少 5 个完整财年；ROE/ROIC/负债/派息先取公司长期中位，稳定性取公司 CV/σ，再在该 f100 内取横截面中位/分位。单项 N<8 不写入 candidate。日常评分只读 `anchors.approved.json`，candidate 不会自动生效。

`build_anchor_pool.js` 拉东财 `push2/clist` 时 **pz=100 并按 pn 翻页**。接口 pz 上限 100，写 `pz=5000` 会被静默截成市值前 100 只，多数行业 N 不够校准。

clist 默认走 `push2delay.eastmoney.com`（本机 `push2` 常 TLS 被掐，`SSL_ERROR_SYSCALL`）。请求顺序：Node `https`（IPv4）→ `curl -4 --http1.1`（不要 `--compressed`）→ 其它 push2 域名 → 最后才 browser。

**PB 当前不校准**：上述抓取没有历史 PB 字段。有 f100 PB 锚则带宽+分位；无锚则 PB 维仅同类分位。

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
node ../scripts/fetch_kline_hfq.js 600900 --period day -o ~/Desktop/temp/600900_day.json
node ../scripts/calc_bollinger.js ~/Desktop/temp/600900_day.json
node ../scripts/calc_bollinger.js ~/Desktop/temp/600900_week.json --period W
node ../scripts/calc_bollinger.js ~/Desktop/temp/600900_month.json --period M
# adapter 失败自动改 push2his fqt=2；强制备援加 --browser-only
```

报告「K 线数据来源」写 `东财 kline --adjust backward` 或 `东财 push2his fqt=2（browser 直开）`。

### 估值分位（已删除次路径；勿用于买卖）

`fetch_valuation_history.js` 仍可算近 5 年 TTM 股息率分位 + PB 分位，但 **skill 已取消估值分位次路径**：

- 禁止用 `allow_batch` / 股息分位≥80 / PB≤20 给「分批」「建仓」「加仓」
- 禁止把「估值分位」写成信号来源
- Step3 只跑布林；可尝试批量建仓 = 月线中轨附近 + 日线中～下轨（周线下轨附近更优、非必须）；未到 → 观望/持有

```bash
# 仅当用户明确要求「看看历史分位」时才跑；默认跳过
node ../scripts/fetch_valuation_history.js 600900.SH -o ~/Desktop/temp/600900_val.json
```

### 10Y 国债

默认 Investing `https://cn.investing.com/rates-bonds/china-10-year-bond-yield`。东财 `zgzmcbysyl.html` 常废页，不要当默认源。

```bash
node ../scripts/fetch_bond_yield.js -o ~/Desktop/temp/buffett_bond.json
```

Step 0 用 `最新股息率 ≥ 国债×2`；Step 1 只把 `bond_ratio` 写入结果，不再用倍数做门槛。

## 字段映射

| 评估字段 | 来源 |
|---|---|
| Step 0 候选 | Result 页 el-table（`xuangu-result-dom`） |
| 行业 f100 | `fetch_industry.js` 的东财 `f100`；禁止代码名单或简称猜测 |
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
| 持久性（非金融） | 近 5 年 `MAINFINADATA.ROIC` / `XSMLL`，进入 ROIC/毛利率持久性维度 |
| 分红纪律 | `DIVIDEND_MAIN` 已实施方案按报告年度汇总「10派 X 元」得 DPS；结合派息率历史波动 |
| 持久性（银行/保险） | 近 5 年 ROE 稳定性 + 分红纪律；专项指标仍按各自原维度评分 |
| 企业性质 | `REAL_CONTROLER`（主）+ `CONTROL_HOLDER` / `ORG_FORM` |
| 连续分红 | `DIVIDEND_MAIN` 按年去重 |
| 估值分位 | `fetch_valuation_history.js`（可选；**不驱动仓位**） |
| 布林 | `kline --adjust backward` 或 `push2his fqt=2` + `calc_bollinger.js`（唯一买卖路径） |
| 10Y 国债 | Investing（默认） |

## 派息率哨兵

1. 优先 PROFILE：小数比 ×100；禁止把 2.235 写成 2.24%
2. 无 PROFILE，或 PROFILE 踩哨兵且 COMPRE 自算更干净 → 同年 `TOTAL_DIVIDEND ÷ PARENT_NETPROFIT`
3. 哨兵：派息 <10% 且 TTM 股息≥3.5% 且 PB≤5；或 股息率 ≈ 派息×ROE/PB 数量级差 ≥3 倍
4. |PROFILE − COMPRE| >15pct 记入 reasons，仍以 PROFILE 为准（派息率打分）
5. **FCF 覆盖分母**（`resolveFcfDivAmounts`）：按年优先 COMPRE 绝对分红；若 COMPRE/隐含(净利×派息) <1/3 → 改用隐含并标注 `compre-incomplete`；禁止只改最近一年、其它年仍用残缺 COMPRE
6. 仍失败标「派息率数据缺口」；>100% 走 `red_lines` 特别分红分支（soft/hard），派息维仍 0

## 抓取原则

1. Prefer adapter / network JSON；F10 认 `reportName`/`type`，不认写死 `#N`
2. eval 只读；禁止用 eval 改 DOM/导航（hash `open` 除外）
3. Step 0 只走 Result 页对齐扫表。禁止 yjfp / 行业表 / 记忆 / search-code
4. 关键 network 包同一回合立刻 `--detail` 落盘
5. 财务数字写明报告期；个股失败可换入口或向用户索要（仅 Step 0 成功后）；禁止编造
6. 布林必须后复权；与现价勿直接比绝对价位
7. 国债默认 Investing；东财国债废页跳过
