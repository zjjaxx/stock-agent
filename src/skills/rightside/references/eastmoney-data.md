# 东方财富数据抓取参考

决策逻辑与每步默认 **Run** 见 `../SKILL.md`。本文件只保留 URL、字段、flags 和完整串联。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `run_step0_xuangu.js` | Step0：xuangu 点选 → Result 页 el-table 扫表出池；唯一条件=总市值 >1000 亿（`--min-yi` 可改） |
| `fetch_industry.js` | Step1：push2 ulist `f100`（curl 优先，失败则 browser）；`--pass-json` 写出带 f100 的池 |
| `industry_map.js` | `f100` → `fin_kind`（仅报告分册，不参与买卖判定） |
| `fetch_kline_hfq.js` | 单票 K 线：`--adjust forward|backward`（默认前复权） |
| `fetch_market_context.js` | Step2 前置：沪深300 + 池内行业板块周线 → 条件1/2（参考）结论与 Mansfield RS；板块名→BK 缓存 `em_boards.json` |
| `fetch_kline_pool.js` | Step2：先拉市场上下文，再池内日/周/月双落盘 `*_qfq`（日线另出 `{code}_stage.json`）与 `*_hfq`（收益观察） |
| `calc_stage.js` | 前复权日线重采样周线 → 笑傲牛熊**六条件买入清单**（30 周均线 + 相对强度；唯一买卖路径） |
| `gen_report.js` | 桌面终报骨架：读 Step1 行业标注池；今日建议=六条件放行；技术位只读前复权 |

已删除：`fetch_bond_yield.js` / `fetch_dividend_streak.js` / `step1_hard_filter.js` / `calc_buy_five_dim.js` / `calc_bollinger.js` / `fetch_f10_bundle.js` / `pack_step2_facts.js` / `red_lines.js`。右侧交易不做国债锚、股息、分红、ROE、五维估值、F10 事实卡与红线机械筛。

```bash
S=scripts
node $S/run_step0_xuangu.js -o ~/Desktop/temp/rightside_xuangu_result.json --pool-json ~/Desktop/temp/rightside_pool.json
# Step1 只挂行业，不剔除任何票
node $S/fetch_industry.js --pool ~/Desktop/temp/rightside_pool.json \
  -o ~/Desktop/temp/rightside_industry.json --pass-json ~/Desktop/temp/rightside_pass_pool.json
# 大盘+行业上下文（条件6 RS 的底座；条件1/2 大盘与行业只作参考提示）
node $S/fetch_market_context.js --industry ~/Desktop/temp/rightside_industry.json
# K 线对全部 N 只；今日名单=条件6 + 突破/回踩
node $S/fetch_kline_pool.js --pool ~/Desktop/temp/rightside_pass_pool.json --resume
node $S/gen_report.js
```

## Step 0

入口 `https://xuangu.eastmoney.com/`。**唯一出池路径**是跑 `run_step0_xuangu.js`（不要手点、不要 `search-code`、不要 yjfp）。

脚本会：切「基本面」→ 总市值 `>1000亿` → 点「去选股」→ 扫 Result 页 el-table。

市值门槛优先点页面预设档位；东财预设档位有限（常见 50/100/500/1000 亿），无 `>1000亿` 预设时脚本回退到自定义区间输入（fill 后必须 get value 验收）。两条路径都以 chip 落地为验收。

**只有市值一条筛选条件**。股息率、PE/PB、ROE、分红等基本面条件一律不加——右侧交易的筛选发生在 Step2 的六条件，不在选股器里。

DOM 口径：固定列（序号/代码/名称/最新价）与滚动列（总市值/PE/PB）**按行对齐**；解析 N 必须等于页内「共 N 只」；来源 `xuangu-result-dom`。N 随行情变，勿拿历史条数当金标准。千亿门槛下 N 通常约百余只，全量进 Step1/Step2，禁止抽样。

失败则整 skill 终止（模板见主 skill Step 0）。禁止改走 yjfp / 行业表 / 记忆凑池。

## 个股字段

执行前 `opencli doctor`。示例 `600900` 须按标的替换 code / 交易所前缀 / 简称。有 adapter 先用 adapter。

### 现价 / 市值

Step0 选股 Result 表已带最新价/市值。调试可用：

```bash
opencli eastmoney quote 600900 -f json
# price, marketCap, peDynamic, priceBook, name, market
```

行情 PE/PB 只作参考展示，**不进入**技术位判定，也不拦今日建仓。

### 行业 f100

```bash
node ../scripts/fetch_industry.js --pool ~/Desktop/temp/rightside_pool.json \
  -o ~/Desktop/temp/rightside_industry.json --pass-json ~/Desktop/temp/rightside_pass_pool.json
```

`push2 /api/qt/ulist.np/get?fields=f12,f14,f100`，每批 80 个 secid。`f100` 缺失不剔除，该票条件2 标「未知（参考）」，不拦买点。禁止用股票简称或代码名单归行业。

### 大盘与行业上下文（条件1/2 参考 / 条件6 前置）

| 对象 | secid | 接口 |
|---|---|---|
| 沪深300（大盘基准） | `1.000300` | `push2his /api/qt/stock/kline/get?klt=101&fqt=1`（日线回拉后按 ISO 周聚合，与个股同周键） |
| 行业板块 | `90.{BK代码}` | 同上；BK 代码取自板块列表 |
| 板块列表 | — | `push2 /api/qt/clist/get?fs=m:90+t:2&fields=f12,f14`，单页上限 100 条，约 496 条需翻页 |

`push2.eastmoney.com` / `push2his.eastmoney.com` 对密集请求会返回 `Empty reply from server`，或给出 `klines:[]` 空数据。脚本的回退链是：主域 → `push2delay`（K 线与板块列表它都提供；`push2hisdelay` 只会 302，不可用）→ 退避 3s 再来一轮 → 仍失败则用 `rightside-kline` 浏览器 session 直开 URL。整段 IP 被限流时只有浏览器兜底能过，代价是整池上下文要跑约 3 分钟。板块列表落盘 `em_boards.json` 复用，`--refresh-boards` 强制重拉。

板块名与 `f100` 精确对应（如 `电力` → `BK0428`），容错会去掉 `Ⅱ/Ⅲ` 后缀再匹配；匹配不到就写「条件2 未知（参考）」，**不否决买点**，但个股结论须带行业未知提示。

相对强度用 Mansfield 口径：`RS =（个股周收盘 / 沪深300 周收盘）÷ 该比值自身 52 周**简单**均值 − 1`，单位为 %，零轴之上即跑赢大盘。这条基准线按 Mansfield 原定义用简单平均，不跟主均线的加权口径走。

### 均线口径

30 周主均线默认 **WMA（线性加权，最近一周权重 30、最远一周权重 1）**——温斯坦书中案例所用的 Mansfield 图表就是加权均线；日线对应 WMA150。个股、大盘、行业三层同口径，两个脚本都支持 `--ma-type sma` 切回简单均线做对照，结果 JSON 里带 `ma_type` 字段。

行情软件默认叠加的多是 SMA 或 EMA，与报告数值会有差异，肉眼比对前先切成 WMA。

### 技术位与复权分工

| 用途 | 复权 | 落盘 | 说明 |
|---|---|---|---|
| 六条件判定 / 报告技术段 | 前复权 `fqt=1` | `{code}_{period}_qfq.json`（兼写旧名 `{code}_{period}.json`） | 最新价≈现价，对照盘面 |
| 近 N 年收益观察 | 后复权 `fqt=2` | `{code}_{period}_hfq.json` | 含息路径；**不进**技术位判定 |

```bash
node ../scripts/fetch_market_context.js --boards 电力
node ../scripts/fetch_kline_hfq.js 600900 --adjust forward --period day -o ~/Desktop/temp/600900_day_qfq.json
node ../scripts/fetch_kline_hfq.js 600900 --adjust backward --period month -o ~/Desktop/temp/600900_month_hfq.json
node ../scripts/calc_stage.js ~/Desktop/temp/600900_day_qfq.json --industry 电力
node ../scripts/fetch_kline_pool.js --pool ~/Desktop/temp/rightside_pass_pool.json --resume
```

单票调试漏了 `--industry` 会把条件2 判成「未知（参考）」，不拦买点；仍建议带上以便写出行业顺逆提示。

报告「K 线数据来源」写前复权；若附录对齐近 N 年收益，注明后复权。禁止混用两套收盘算同一条均线。

### 六条件的量化口径（唯一买卖路径）

`calc_stage.js` 的常量与门槛：

| 项 | 常量 | 值 |
|---|---|---|
| 主均线 | `MA_WEEKS` / `MA_TYPE` | 30 周 / `wma` |
| 均线斜率窗 | `SLOPE_WEEKS` | 5 周 |
| 阻力区窗 | `BASE_WEEKS` | 30 周（不含本周） |
| 量能基准窗 | `VOLUME_WINDOW` | 26 周（**不含**被测周自身，否则放量周会稀释自己的倍数） |
| 条件4 单周门槛 | `VOLUME_SURGE` | 2.0 |
| 条件4 多周备选 | `VOLUME_MULTI_WEEKS` / `VOLUME_MULTI_SURGE` / `BREAKOUT_WEEK_MIN_RATIO` | 4 周 / 2.0 / 1.2 |
| 条件3 突破新鲜度 | `BREAKOUT_MAX_WEEKS` | 8 周 |
| 条件3 追高上限 | `ENTRY_MAX_DEV_PCT` | 12% |
| 条件3 上方阻力 | `OVERHEAD_WEEKS` / `OVERHEAD_MAX_PCT` | 104 周 / ≤20% |
| 条件3 **阶段1 底座** | `BASE_PRIOR_MAX/MIN` / `BASE_SLOPE_MIN/MAX` / `BASE_LOW_TOLERANCE` / `BASE_DECLINE_*` | 突破前一周：前26周均线 −30%～+8%；斜率 −1.5%～+3%；底座后半低点 ≥ 前半×0.97；52→26 周均线跌 ≥5%（或 prior26<0） |
| 条件5 回踩区 | `PULLBACK_UNDERCUT_PCT` / `PULLBACK_DEV_PCT` | −3% ～ +5% |
| 条件5 缩量 | `PULLBACK_VOL_MAX` | ≤0.8 |
| 条件5 趋势已确立 | `PRIOR_TREND_WEEKS` / `TREND_MATURE_PCT` | 前 26 周均线 ≥ +3% |
| 条件5 **前置突破** | `PULLBACK_BREAKOUT_LOOKBACK` / `PULLBACK_BREAKOUT_VOL_MIN` | 近 52 周内 / 突破周量比 ≥**2.0**（与条件4 同），**且通过阶段1 底座校验** |
| 条件6 RS | `RS_WEEKS` / `RS_CROSS_WEEKS` / `RS_SLOPE_WEEKS` | 52 周基准 / 8 周转正窗 / 4 周斜率窗 |
| 最少数据 | — | 36 根周 bar |

放行 = `条件6 && !条件6否决`，之后 `3+4` = 突破买点，`5` = 回踩买点。条件1、2 不参与放行，只附逆势/逆行业提示。

**条件3 与条件5 用两个不同的突破搜索窗口**：条件3 只认近 8 周的「刚突破」（内部搜索窗 12 周），条件5 要的是近 52 周内一次**已完成且当时放量**的突破。两者都要求突破建立在**阶段1 底座**上（`assessStage1Base`）：中途新高一律否决。若把条件5 也压到 12 周，绝大多数真回踩会被误杀——突破后走一段再回抽到 30 周均线，本就常隔 20～50 周。

**不出目标位**：近端目标、量度目标一律不写；只写触发价（阻力区上沿）与止损参考（`min(阻力区下沿, MA30W) × 0.97`）。

## 字段映射

| 评估字段 | 来源 |
|---|---|
| Step 0 候选 | Result 页 el-table（`xuangu-result-dom`），唯一条件总市值 >1000 亿 |
| 行业 f100 | `fetch_industry.js` 的东财 `f100`（分册）；禁止代码名单或简称猜测 |
| 现价/市值 | Step0 Result 表 |
| 技术位（六条件） | `*_qfq` 前复权日线 + `calc_stage.js`（唯一买卖路径） |
| 大盘 / 行业 / 相对强度 | `fetch_market_context.js` → `rightside_market_context.json` |
| 收益观察 | `*_hfq` 后复权月线 |

## 抓取原则

1. Prefer adapter / network JSON
2. eval 只读；禁止用 eval 改 DOM/导航（hash `open` 除外）
3. Step 0 只走 Result 页对齐扫表，且只设市值一个条件。禁止 yjfp / 行业表 / 记忆 / search-code
4. 关键 network 包同一回合立刻 `--detail` 落盘
5. 禁止编造行情数字；本 skill 不做基本面分析
6. 技术位判定必须前复权日线（重采样周线）；回测/校准用后复权；禁止混用同一条指标
7. 条件6 的上下文缺失时判「未知」并观望，不得当作通过；条件1/2 缺失只写「未知（参考）」，不拦买点
8. 池子大不是抽样的理由，用 `fetch_kline_pool.js --resume` 续跑
