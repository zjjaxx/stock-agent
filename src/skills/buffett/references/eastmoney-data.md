# 东方财富数据抓取参考

决策逻辑与每步默认 **Run** 见 `../SKILL.md`。本文件只保留 URL、字段、flags 和完整串联。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：xuangu 点选 → Result 页 el-table 扫表出池；股息下限=10Y国债×2 |
| `fetch_bond_yield.js` | Investing 中国 10Y 国债收益率 |
| `fetch_dividend_streak.js` | Step1：`DIVIDEND_MAIN` 连续年报分红年限（挂卡展示，不作硬筛） |
| `fetch_industry.js` | Step1：push2 ulist `f100`（curl 优先，失败则 browser） |
| `step1_hard_filter.js` | Step1：股息缺失初筛（连续分红只挂卡不剔除；市值只在 Step0）；`--pass-json` 写出通过池 |
| `fetch_kline_hfq.js` | 单票 K 线：`--adjust forward|backward`（默认前复权） |
| `fetch_kline_pool.js` | Step2：池内日/周/月双落盘 `*_qfq`（+布林）与 `*_hfq`（收益观察） |
| `calc_bollinger.js` | 前复权收盘算布林（唯一买卖路径；输入应为 qfq） |
| `calc_buy_five_dim.js` | Step3：建仓票五维自身分位（PE/PB/ERP/DRP/现价，2Y窗） |
| `gen_buffett_report.js` | 桌面终报骨架：读 Step1 通过池；今日建议=布林到位；自动跑五维；技术位只读前复权 |

已删除：`fetch_f10_bundle.js` / `pack_step2_facts.js` / `red_lines.js`（不再做 F10 事实卡与红线机械筛）。

```bash
S=scripts
node $S/run_step0_xuangu.js -o ~/Desktop/temp/buffett_xuangu_result.json --pool-json ~/Desktop/temp/buffett_pool.json
# 国债默认写入 ~/Desktop/temp/buffett_bond.json；也可事先 fetch_bond_yield.js 再 --bond-json
node $S/fetch_dividend_streak.js --pool ~/Desktop/temp/buffett_pool.json -o ~/Desktop/temp/buffett_streak.json
node $S/fetch_industry.js --pool ~/Desktop/temp/buffett_pool.json -o ~/Desktop/temp/buffett_industry.json
node $S/step1_hard_filter.js --pool ~/Desktop/temp/buffett_pool.json --streak ~/Desktop/temp/buffett_streak.json \
  --industry ~/Desktop/temp/buffett_industry.json --bond-json ~/Desktop/temp/buffett_bond.json \
  -o ~/Desktop/temp/buffett_step1.json --pass-json ~/Desktop/temp/buffett_pass_pool.json
# K 线对全部 M 只；今日名单=布林到位；建仓票跑五维
node $S/fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json --resume
node $S/gen_buffett_report.js
```

## Step 0

入口 `https://xuangu.eastmoney.com/`。**唯一出池路径**是跑 `run_step0_xuangu.js`（不要手点、不要 `search-code`、不要 yjfp）。

脚本会：切「基本面」→ 总市值 `>1000亿` → 最新股息率自定义 `[国债×2, 100]`（fill 后必须 get value 验收，上限勿被默认成 5）→ 点「去选股」→ 扫 Result 页 el-table。

DOM 口径：固定列（序号/代码/名称/最新价）与滚动列（股息/总市值/PE/PB）**按行对齐**；解析 N 必须等于页内「共 N 只」；来源 `xuangu-result-dom`。N 随国债与行情变，勿拿历史条数当金标准。

失败则整 skill 终止（模板见主 skill Step 0）。禁止改走 yjfp / 行业表 / 记忆凑池。

## 个股字段

执行前 `opencli doctor`。示例 `600900` 须按标的替换 code / 交易所前缀 / 简称。有 adapter 先用 adapter。

### 现价 / 市值 / PE / PB

Step0 选股 Result 表已带最新价/市值/股息；五维估值另走 `RPT_VALUEANALYSIS_DET`。调试可用：

```bash
opencli eastmoney quote 600900 -f json
# price, marketCap, peDynamic, priceBook, name, market
```

### 连续分红（挂卡展示）

`fetch_dividend_streak.js` 读 `RPT_F10_DIVIDEND_MAIN` 年报现金分红年数；只展示，不作硬筛剔除。

### 布林与复权分工

| 用途 | 复权 | 落盘 | 说明 |
|---|---|---|---|
| 今日布林 / 报告技术位 | 前复权 `fqt=1` | `{code}_{period}_qfq.json`（兼写旧名 `{code}_{period}.json`） | 最新价≈现价，对照盘面 |
| 近 N 年收益观察 | 后复权 `fqt=2` | `{code}_{period}_hfq.json` | 含息路径；**不算**今日买卖布林 |

```bash
node ../scripts/fetch_kline_hfq.js 600900 --adjust forward --period day -o ~/Desktop/temp/600900_day_qfq.json
node ../scripts/fetch_kline_hfq.js 600900 --adjust backward --period month -o ~/Desktop/temp/600900_month_hfq.json
node ../scripts/calc_bollinger.js ~/Desktop/temp/600900_day_qfq.json
node ../scripts/fetch_kline_pool.js --pool ~/Desktop/temp/buffett_pass_pool.json --resume
```

报告「K 线数据来源」写前复权；若附录对齐近 N 年收益，注明后复权。禁止混用两套收盘算同一条布林。

### 估值分位与质地评分 / F10 事实卡 / 红线（已删除；勿用于买卖）

`fetch_f10_bundle.js`、`pack_step2_facts.js`、`red_lines.js`、`score_numeric.js`、估值分位次路径、同业第1/候补、PE/PB 绝对值闸门均已删除：

- 禁止用 `allow_batch` / 股息分位 / PE·PB 模板门槛 / 红线机械提示给建仓建议
- Step2 只跑布林；可尝试批量建仓 = **周线下轨附近 + 月线中轨～下轨**；边界一律相对股价 ≤5%。日线不进门槛。未到 → **观望**。须标明信号来源是布林带

### 10Y 国债

默认 Investing `https://cn.investing.com/rates-bonds/china-10-year-bond-yield`。东财 `zgzmcbysyl.html` 常废页，不要当默认源。

```bash
node ../scripts/fetch_bond_yield.js -o ~/Desktop/temp/buffett_bond.json
```

Step 0 用 `最新股息率 ≥ 国债×2`；Step 1 硬筛只把 `bond_ratio` 写入结果，不再用倍数做门槛。

## 字段映射

| 评估字段 | 来源 |
|---|---|
| Step 0 候选 | Result 页 el-table（`xuangu-result-dom`） |
| 行业 f100 | `fetch_industry.js` 的东财 `f100`（分册）；禁止代码名单或简称猜测 |
| 现价/市值/TTM股息 | Step0 Result 表 |
| 连续分红 | `DIVIDEND_MAIN` 按年去重（挂卡） |
| 布林 | `*_qfq` 前复权 + `calc_bollinger.js`（唯一买卖路径） |
| 收益观察 | `*_hfq` 后复权月线 |
| 五维估值 | `RPT_VALUEANALYSIS_DET`（PE/PB/价）；股息优先表内字段，缺则 `RPT_F10_DIVIDEND_MAIN` 除权 DPS 滚 365 天 TTM/收盘 |
| 10Y 国债 | Investing（默认） |

## 抓取原则

1. Prefer adapter / network JSON
2. eval 只读；禁止用 eval 改 DOM/导航（hash `open` 除外）
3. Step 0 只走 Result 页对齐扫表。禁止 yjfp / 行业表 / 记忆 / search-code
4. 关键 network 包同一回合立刻 `--detail` 落盘
5. 禁止编造财务数字；本 skill 不做 F10 事实卡打包
6. 今日布林必须前复权；回测/校准用后复权；禁止混用同一条指标
7. 国债默认 Investing；东财国债废页跳过
