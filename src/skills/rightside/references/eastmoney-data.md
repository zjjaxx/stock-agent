# 东方财富数据抓取参考（定投回测）

决策逻辑与每步默认 **Run** 见 `../SKILL.md`。本文件只保留 URL、字段、flags 和串联。

## 脚本与串联

| 脚本 | 用途 |
|---|---|
| `fetch_dca_universe.js` | Step0：拉沪深300 / 红利低波日线 |
| `calc_bollinger.js` | Step1：日线→周/月布林，映射日信号（防前视） |
| `run_backtest.js` | Step2：择时定投 / 无脑定投 × 3 年窗回测 |
| `gen_report.js` | Step3：桌面 Markdown 对比表 |
| `run_all.js` | 一键串联 |
| `fetch_kline_hfq.js` | 单标的 K 线调试 |
| `opencli_json.js` | HTTP / browser / tmpPath 公共库 |

```bash
S=scripts
node $S/run_all.js
# 或分步：
node $S/fetch_dca_universe.js --symbols hs300,hldf,zzhl,hldf_idx
node $S/calc_bollinger.js ~/Desktop/temp/dca_hs300_day.json
node $S/calc_bollinger.js ~/Desktop/temp/dca_zzhl_day.json
node $S/calc_bollinger.js ~/Desktop/temp/dca_hldf_day.json
node $S/run_backtest.js --capital 200000 --daily 500 --floor 100000 --window-years 3
node $S/gen_report.js --result ~/Desktop/temp/dca_backtest_result.json
```

## 标的 secid

| key | 名称 | secid | 复权 | 说明 |
|---|---|---|---|---|
| hs300 | 沪深300ETF华泰柏瑞 | `1.510300` | 前复权 `fqt=1` | 约 2012-05 起 |
| zzhl | 中证红利ETF招商 | `1.515080` | 前复权 `fqt=1` | 约 2019-12 起 |
| hldf | 红利低波ETF华泰柏瑞 | `1.512890` | 前复权 `fqt=1` | 约 2019-01 起 |
| hldf_idx | 红利低波100 | `2.930955` | 不复权 | 指数对照（可选） |

主对比默认用 **hs300 + zzhl + hldf**（三只 ETF 前复权同口径）。

## K 线接口

```
GET https://push2his.eastmoney.com/api/qt/stock/kline/get
  ?secid={secid}&fields1=f1,f2,f3,f4,f5,f6
  &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
  &klt=101&fqt={0|1}&end=20500101&lmt=5000
```

回退链：`push2his` → `push2delay` → browser session `rightside-kline`。主域限流时空 `klines` 或 Empty reply，以浏览器兜底为准。

单票调试：

```bash
node ../scripts/fetch_kline_hfq.js 512890 --market SH --adjust forward --period day --limit 3000 \
  -o ~/Desktop/temp/512890_day_qfq.json
```

`marketFromCode` 已支持 `5xxxxx` → SH（ETF）。

## 布林与防前视

- 日线按 ISO 周 / 自然月重采样（该周/月最后交易日 OHLC）
- 布林：SMA(20) ± 2×样本标准差
- **日信号只用上一根已收盘周/月的中轨/上轨**，不用当周/当月未完成 bar

落盘 `{stem}_boll.json`：`daily[].week_mid` / `month_upper` / `signal_buy` / `signal_sell_band`。

## 回测参数（默认）

| 参数 | 默认 |
|---|---|
| capital | 200000 |
| daily | 500 |
| floor | 100000（≤ 此市值不卖） |
| window-years | 3 |
| 卖出比例 | 持仓份额 1/5 |

牛熊标签：窗内买入持有收益 ≥+15% 牛 / ≤−15% 熊 / 其余震荡。

## 落盘约定

一律 `~/Desktop/temp/`：

- `dca_hs300_day.json` / `dca_zzhl_day.json` / `dca_hldf_day.json` / `dca_hldf_idx_day.json`
- `*_boll.json`
- `dca_backtest_result.json`
- `dca_universe_meta.json`

报告目录：`~/Desktop/dca-compare-YYYYMMDDHHmm/`（`00-总览.md` + `10-{key}.md`）。

## 抓取原则

1. Prefer HTTP；失败再用 browser
2. 禁止凭记忆编造收益数字
3. 报告必须写 secid / 复权 / 信号区间
