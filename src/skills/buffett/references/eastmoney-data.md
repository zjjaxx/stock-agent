# 东方财富数据抓取参考

主 skill 决策逻辑见 `../SKILL.md`。需要具体 URL、字段来源或 opencli 命令时再读本文件。

## Step 0：条件选股构建动态候选池（强制）

**入口**：`https://xuangu.eastmoney.com/`（条件选股）  
**目的**：现场查出当日池，禁止用 `SKILL.md` 行业表示例名单顶替。

### 推荐操作流（opencli-browser）

```bash
opencli doctor
opencli browser buffett-xuangu open "https://xuangu.eastmoney.com/"
opencli browser buffett-xuangu wait text "条件选股"

# 方式 A（优先）：点选内置策略「高股息大盘」
#   title≈「总市值大于等于200亿;市盈率(TTM)0-20;股息率(近12个月)大于等于4%;」
#   state 找到该节点后 click；筛选条应出现「总市值」「最新股息率」等 chip
#   再按需收紧：点「自定义总市值」改为 ≥1000亿 等（本框架市值硬门槛）

# 方式 B：基本面结构化点选
#   切到「基本面」→「总市值」自定义 ≥1000亿
#   →「最新股息率」（页面说明默认=股息率TTM）自定义 ≥3.5%
#   可选：范围→概念勾选「中特估」「央企改革」作召回优先（非强制过滤；≠企业性质终审）

# ⚠️ 自然语言框（「一句话包含多指标」）对 agent 解析不稳定，不要当作主路径

opencli browser buffett-xuangu network
opencli browser buffett-xuangu network --detail "GET np-tjxg-b.eastmoney.com/api/smart-tag/stock/v3/pw/search-code"
```

### 结果接口（优先于 DOM）

| 项 | 值 |
|---|---|
| Key / URL | `GET np-tjxg-b.eastmoney.com/api/smart-tag/stock/v3/pw/search-code` |
| 列表路径 | `data.result.dataList[]` |
| 常用字段 | `SECURITY_CODE`、`MARKET_SHORT_NAME`、股息率类（如 `DIVIDEND_NEWRATIO_HYY{日期}`）、市值/价量字段 |

报告 Step 0 时写明：筛条件（或预设名）、抓取时点、`dataList` 条数 N 与**完整**代码列表（禁止只摘前几条）。  
`dataList` 全量进入主 skill Step 1；过硬门槛的 M 只全部做后续深度分析。

### 失败处理（强制终止，无回退）

条件选股失败时**立即终止**整个 buffett 流程，不得改走 `yjfp` 分红榜、不得用行业表示例凑名单。

判定失败（任一即可）：
- 无法打开/操作 `https://xuangu.eastmoney.com/`
- 无法形成有效筛条件或结果为空/不可信
- `search-code` 抓不到可用 `data.result.dataList`

终止输出模板见主 skill Step 0「Step 0 失败 = 立即终止」。

---

## 个股深度字段：opencli-browser 抓取流程

执行前先跑：`opencli doctor`（不过则先修环境，再谈抓数）。

> 下方示例以 `600900 长江电力` 演示；**实际执行时必须按目标标的替换**：
> - 代码：`600900` → 目标 6 位代码
> - 交易所前缀：沪 `sh`/`SH`，深 `sz`/`SZ`，北 `bj`/`BJ`
> - 简称：`长江电力` → 目标公司简称（用于 `wait text`）

对每只标的按此顺序执行（链式 `&&` 保持同一会话）：

```bash
# 0. 环境检查
opencli doctor

# 1. 打开个股行情页，抓现价/市值/估值
opencli browser tab new "https://quote.eastmoney.com/sh600900.html"
opencli browser wait text "长江电力"
opencli browser network              # 优先抓 push2 / datacenter JSON
opencli browser network --detail <key>

# 2. 打开 F10，切到分红/财务 Tab
opencli browser tab new "https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code=SH600900"
opencli browser wait text "分红"
opencli browser state                # 找到 Tab ref 后再 click
opencli browser network
opencli browser network --detail <key>

# 3. 布林带主路径：东财后复权 kline（须显式 --adjust backward；默认是 forward）
opencli eastmoney kline 600900 --period day --adjust backward --limit 520 -f json
opencli eastmoney kline 600900 --period week --adjust backward --limit 80 -f json
opencli eastmoney kline 600900 --period month --adjust backward --limit 40 -f json
# 对后复权 close 用 ../scripts/calc_bollinger.py（接受 date 或 trade_date）自算
# 可选备选：Tushare fetch_hfq_daily.py（adj_factor 易 40203 频率超限，批量勿依赖）
# 禁止手抄页面布林值
```

## 东方财富入口 URL

| 数据类型 | URL 模板 |
|---|---|
| **条件选股（Step 0，唯一入池路径）** | `https://xuangu.eastmoney.com/` |
| 个股行情页 | `https://quote.eastmoney.com/{sh\|sz\|bj}{code}.html` |
| F10 资料 | `https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code={SH\|SZ\|BJ}{code}` |
| 分红配送（仅个股字段参考，**不是 Step 0 回退**） | `https://data.eastmoney.com/yjfp/` |
| 公司公告 | F10 公告或 `opencli eastmoney announcement` |

secid 规则：沪市 `1.{code}`，深市/北交 `0.{code}`。

## 字段映射目标

| 评估字段 | 东财优先来源 |
|---|---|
| Step 0 候选列表 | xuangu `search-code` → `data.result.dataList` |
| 当前价/总市值 | `quote` 或行情页 push2 |
| PE(动态)/PB | `quote`：`peDynamic`/`priceBook` |
| TTM股息率 | F10 分红融资（**滚动12个月实际分红口径**；剔除特别分红）；初筛可用 xuangu「最新股息率」 |
| 派息率 | F10 分红/财务 |
| ROE(近3年) | F10 主要指标（年报口径均值） |
| 经营现金流/净利润 | F10 财务分析（连续两年） |
| 资本开支（算FCF用） | F10 现金流量表："购建固定资产、无形资产和其他长期资产支付的现金" |
| 年度分红总额 | F10 分红融资（历史分红表合计） |
| 银行专项（不良率/拨备覆盖率/核充率/净息差） | F10 主要指标（银行版） |
| 资产负债率 | F10 资产负债表 |
| 企业性质 | F10 公司概况/股本结构（**优先央国企，非必须**；概念勾选≠终审） |
| 连续分红年限 | F10 历史分红表 |
| 分红承诺 | 公告全文/章程 |
| 布林带 | **主路径** `eastmoney kline --adjust backward` 后自算；可选 Tushare `fetch_hfq_daily.py` |
| 股息率/PB历史分位（兜底用） | F10 估值分析，或 kline+历史每股分红/每股净资产自算近5年序列 |

## 抓取原则

1. **Prefer network JSON over DOM**：东财数据几乎都来自 `push2`/`push2his`/`datacenter-web`/`np-tjxg-b` JSON
2. **eval 只读**：禁止用 eval 提交表单或导航
3. **批量初筛（Step 0）**：必须且只能用条件选股 xuangu + network 拉列表；失败则终止，禁止 yjfp/行业表回退
4. **时效标注**：所有财务数字注明报告期（如"2025年报/2026Q1"），过季必须重抓
5. **失败处理**：Step 0 失败→终止全流程；个股字段接口失败可换同站入口或向用户索要（仅 Step 0 成功后）；禁止编造
6. **复权处理**：布林带必须用**后复权**收盘价；默认东财 `kline --adjust backward`（勿用默认 forward）；Tushare 仅作可选备选
7. **概念软预筛**：xuangu「中特估/央企改革」只扩召回优先；企业性质非硬门槛，非央国企须按 skill「例外纳入」标注
