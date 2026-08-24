# 东方财富数据抓取参考

决策逻辑与每步默认 **Run** 见 `../SKILL.md`。本文件只保留 URL、字段、flags 和完整串联。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：xuangu 点选 → Result 页 el-table 扫表出池；股息下限=10Y国债×2 |
| `fetch_bond_yield.js` | Investing 中国 10Y 国债收益率 |
| `fetch_dividend_streak.js` | Step1：`DIVIDEND_MAIN` 连续年报分红年限（挂卡展示，不作硬筛） |
| `fetch_industry.js` | Step1：push2 ulist `f100`（curl 优先，失败则 browser） |
| `step1_hard_filter.js` | 股息缺失初筛（连续分红只挂卡不剔除；市值只在 Step0）；`--pass-json` 写出通过池 |
| `fetch_f10_bundle.js` | Step2：ORG/DUPONT/GCASHFLOW/COMPRE/PROFILE/MAINFINADATA + quote；含 DPS/派息历史与 5 年持久性数据 |
| `pack_step2_facts.js` | 合并 Step1+F10 为事实卡，并写入全量数字评分与总分 |
| `score_numeric.js` | 硬筛池 M 内同三级行业（无 l3 则 f100）分位评分；n=1 自身历史≥3 年否则缺维；hard 红线另算（`--self-test`） |
| `red_lines.js` | Step2 红线机械提示 hard/soft（`--self-test`）；特别分红走 soft |
| `fetch_kline_hfq.js` | 单票 K 线：`--adjust forward|backward`（默认前复权） |
| `fetch_kline_pool.js` | Step3：池内日/周/月双落盘 `*_qfq`（+布林）与 `*_hfq`（回测） |
| `calc_bollinger.js` | 前复权收盘算布林（唯一买卖路径；输入应为 qfq） |
| `rank_vs_return.js` | 后复权月线核对评分排序 ↔ 近 N 年收益（不进买卖） |
| `gen_buffett_report.js` | 桌面终报骨架：目录分册；技术位只读前复权 |

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
# 复核 hard 红线；总分取事实卡；K 线对全部 M 只；今日名单=全样本同业第1+布林+无 hard
node $S/fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json --resume
node $S/gen_buffett_report.js
```

## Step 0

入口 `https://xuangu.eastmoney.com/`。**唯一出池路径**是跑 `run_step0_xuangu.js`（不要手点、不要 `search-code`、不要 yjfp）。

脚本会：切「基本面」→ 总市值 `>500亿` → 最新股息率自定义 `[国债×2, 100]`（fill 后必须 get value 验收，上限勿被默认成 5）→ 点「去选股」→ 扫 Result 页 el-table。

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

### 布林与复权分工

| 用途 | 复权 | 落盘 | 说明 |
|---|---|---|---|
| 今日布林 / 报告技术位 | 前复权 `fqt=1` | `{code}_{period}_qfq.json`（兼写旧名 `{code}_{period}.json`） | 最新价≈现价，对照盘面 |
| 回测 / 3 年收益校准 | 后复权 `fqt=2` | `{code}_{period}_hfq.json` | 含息路径；**不算**今日买卖布林 |

```bash
node ../scripts/fetch_kline_hfq.js 600900 --adjust forward --period day -o ~/Desktop/temp/600900_day_qfq.json
node ../scripts/fetch_kline_hfq.js 600900 --adjust backward --period month -o ~/Desktop/temp/600900_month_hfq.json
node ../scripts/calc_bollinger.js ~/Desktop/temp/600900_day_qfq.json
node ../scripts/fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json --resume
node ../scripts/rank_vs_return.js --months 36
```

报告「K 线数据来源」写前复权；若附录对齐近 N 年收益，注明后复权。禁止混用两套收盘算同一条布林。

### 估值分位（已删除；勿用于买卖）

估值分位次路径与 `fetch_valuation_history.js` 已删除：

- 禁止用 `allow_batch` / 股息分位≥80 / PB≤20 给「分批」或建仓建议
- 禁止把「估值分位」写成信号来源
- Step3 只跑布林；可尝试批量建仓 = **周线下轨附近 + 月线中轨～下轨 + 当前 PE/PB 绝对值未达本模板偏贵门槛**；边界一律相对股价 ≤5%（周：略高下轨≤5%；月：落在 `[下轨×0.95, 中轨×1.05]`）。技术位 PE/PB 用行情**绝对值、按评分模板分档**（见 `VAL_ABS_BY_KIND`；默认 corp：PE≥20 或 PB≥2；银行更紧、品牌/科技更松），不分位、不比自身年末史、不比同行。评分表 PE/PB 仍用同类分位，规则不变。日线不进门槛。今日建议另须本行业全样本第1且无 hard 红线 / ⚠️；未到或绝对值偏贵 → **观望**（只拦新开仓，不是卖出）。须标明信号来源是布林带

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
| 行业 f100 | `fetch_industry.js` 的东财 `f100`（画像/权重回退）；同行比较优先 F10 `BOARD_NAME_3LEVEL`；禁止代码名单或简称猜测 |
| 现价/市值/PE/PB | `eastmoney quote`；n=1 自身分位另用 `RPT_VALUEANALYSIS_DET` 年末 PE_TTM/PB_MRQ（禁止当买点） |
| TTM 股息率 | 初筛：Result「最新股息率」；个股：PROFILE.`DIVIDEND_NEWRATIO` |
| 派息率 | 优先 PROFILE.`DIVIDEND_PAY_RATIO`（×100）；哨兵触发则同年 COMPRE÷净利 |
| ROE(3 年) | `MAINFINADATA.ROEJQ` 或 `DUPONT.ROE`（年报） |
| 经营现金流 / 净现比 | `GCASHFLOW.NETCASH_OPERATE` / `MAINFINADATA.NCO_NETPROFIT`（年报至少 5 年，`pageSize≥24`） |
| 资本开支 | `GCASHFLOW.CONSTRUCT_LONG_ASSET` |
| 年度分红 | `DIVIDEND_COMPRE.TOTAL_DIVIDEND` |
| 负债率 | `DUPONT.DEBT_ASSET_RATIO`（银行/保险不用；证券用，池内同类分位） |
| 银行专项 | `NONPERLOAN` / `BLDKBBL` / `HXYJBCZL` / `NET_INTEREST_MARGIN` / `NON_PERFORMING_LOAN` / `GROSSLOANS` / `OVERDUE_LOANS`；非息占比来自 `GINCOME` 利息净收入与营业总收入 |
| 保险专项 | `SOLVENCY_AR` / `NET_ROI` / `TOTAL_ROI` / `NBV_LIFE` / `NBV_RATE`（年报 TOTAL_ROI 空时中报回退；无 IRR/EV/P/EV） |
| 证券专项 | `RISK_COVERAGE` / `CAPITAL_LEVERAGE_RATIO` / `ZYGDSYLZQJZB`；利润表手续费/利息/投资占比与同比（无两融市占、自营收益率、资管 AUM） |
| 公用事业专项 | `INTEREST_COVERAGE_RATIO`（空则 `GINCOME` 营业利润/利息支出） / `YSZKZZTS` / `TOTALOPERATEREVETZ` / `PARENTNETPROFITTZ`；经营现金流/净利润；DPS 同比；无 EV/EBITDA 时估值用 PB |
| 周期资源专项 | 毛利率自身分位（周期热度）；5年毛利中位；`INTEREST_COVERAGE_RATIO`（空则利润表回退） / `INTEREST_DEBT_RATIO`；Capex/OCF；无商品价/AISC/储量 |
| 品牌消费专项 | `CONTRACT_LIAB_YOY`（GBALANCE，同比越低越好防压货）；`YSZKZZTS`；OCF/净利；净利 CAGR；毛利年变动；PE 池内分位（权低于工业）；无社会库存/吨价 |
| 白电专项 | 同品牌消费字段 + `CHZZTS` 存货天；合同负债同比；去 FCF/派息霸权 |
| 装备制造专项 | OCF/净利；利息保障（空则利润表回退）；有息负债率；应收天；合同负债同比（订单代理）；PE+PB |
| 科技硬件专项 | ROIC/毛利持久；OCF/净利；应收/存货天；净利 CAGR；合同负债；PE 权更高 |
| 基建建筑专项 | OCF/营收；`YSZKZZTS`；`INTEREST_COVERAGE_RATIO`（空则利润表回退）；`INTEREST_DEBT_RATIO`；`CONTRACT_ASSET`/`CONTRACT_ASSET_YOY`（无新签订单）；`NOTE_ACCOUNTS_RECE_YOY`（地产敞口代理）；毛利年变动；PE+PB；无减值充足率/海外订单占比 |
| 持久性（非金融） | 近 5 年 `MAINFINADATA.ROIC` / `XSMLL`，进入 ROIC/毛利率持久性维度 |
| 分红纪律 | `DIVIDEND_MAIN` 已实施方案按报告年度汇总「10派 X 元」得 DPS；结合派息率历史波动 |
| 持久性（银行/保险/证券） | 近 5 年 ROE 稳定性 + 分红纪律；证券另评负债率。`fin_kind` 优先 l3、过细回退 f100（utility/brand_consumer/resource_cycle/infra_construction/corp + 银保证） |
| 连续分红 | `DIVIDEND_MAIN` 按年去重 |
| 布林 | `*_qfq` 前复权 + `calc_bollinger.js`（唯一买卖路径） |
| 收益校准 | `*_hfq` 后复权 + `rank_vs_return.js` |
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
6. 今日布林必须前复权；回测/校准用后复权；禁止混用同一条指标
7. 国债默认 Investing；东财国债废页跳过
