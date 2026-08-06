"""用后复权收盘价计算布林带（供 buffett Step 4）。

默认参数与 SKILL.md 一致：
  - 日线/周线：20 期，2 倍标准差
  - 月线：24 期，2 倍标准差

输入（任选其一）：
  1) 东财 `opencli eastmoney kline ... --adjust backward -f json`（字段 date/close，或包在数组/带 rows 的对象里）
  2) fetch_hfq_daily.py 产出的 JSON（bars[].trade_date / close）
  3) stdin 同结构 JSON

用法:
  opencli eastmoney kline 600900 --period day --adjust backward --limit 520 -f json > /tmp/k.json
  python3 calc_bollinger.py /tmp/k.json
  python3 calc_bollinger.py /tmp/hfq.json --period D --window 20 --nbdev 2
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from typing import Any


DEFAULTS = {
    "D": {"window": 20, "nbdev": 2.0},
    "W": {"window": 20, "nbdev": 2.0},
    "M": {"window": 24, "nbdev": 2.0},
}


def load_payload(path: str | None) -> dict[str, Any] | list[Any]:
    if path:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


def normalize_date(raw: Any) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    digits = re.sub(r"\D", "", s)
    if len(digits) >= 8:
        return digits[:8]
    return None


def to_bars(payload: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    for key in ("bars", "data", "rows", "items", "kline", "klines"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    raise ValueError(
        "输入 JSON 须为 K 线数组，或含 bars/data/rows[]（东财 kline / Tushare fetch_hfq）"
    )


def resample_closes(
    bars: list[dict[str, Any]], period: str
) -> list[tuple[str, float]]:
    """period: D|W|M。周/月取该周期最后一个交易日的后复权收盘价。"""
    daily: list[tuple[str, float]] = []
    for row in bars:
        date = normalize_date(row.get("trade_date") or row.get("date") or row.get("day"))
        close = row.get("close")
        if not date or close is None:
            continue
        try:
            c = float(close)
        except (TypeError, ValueError):
            continue
        if math.isnan(c):
            continue
        daily.append((date, c))
    daily.sort(key=lambda x: x[0])

    if period == "D":
        return daily

    buckets: dict[str, tuple[str, float]] = {}
    for date, close in daily:
        y, m, d = int(date[0:4]), int(date[4:6]), int(date[6:8])
        if period == "M":
            key = f"{y:04d}{m:02d}"
        else:  # W — ISO 周
            import datetime as dt

            key = dt.date(y, m, d).strftime("%G-W%V")
        # 同桶保留较晚交易日
        prev = buckets.get(key)
        if prev is None or date >= prev[0]:
            buckets[key] = (date, close)

    return [buckets[k] for k in sorted(buckets)]


def bollinger(
    series: list[tuple[str, float]], window: int, nbdev: float
) -> dict[str, Any]:
    if len(series) < window:
        return {
            "ok": False,
            "error": f"有效样本 {len(series)} < window={window}，无法计算布林带",
            "count": len(series),
        }

    closes = [c for _, c in series]
    # 用尾部 window 根算当前轨（与 skill「当前位置」一致）
    window_closes = closes[-window:]
    mean = sum(window_closes) / window
    var = sum((x - mean) ** 2 for x in window_closes) / window  # 总体标准差（常用交易口径）
    std = math.sqrt(var)
    upper = mean + nbdev * std
    lower = mean - nbdev * std
    last_date, last_close = series[-1]
    bandwidth = (upper - lower) / mean if mean else None

    return {
        "ok": True,
        "as_of": last_date,
        "close": round(last_close, 4),
        "mid": round(mean, 4),
        "upper": round(upper, 4),
        "lower": round(lower, 4),
        "bandwidth": None if bandwidth is None else round(bandwidth, 6),
        "bandwidth_pct": None if bandwidth is None else round(bandwidth * 100, 2),
        "window": window,
        "nbdev": nbdev,
        "sample_count": len(series),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="后复权收盘价布林带（buffett Step 4）")
    parser.add_argument(
        "input",
        nargs="?",
        help="东财 kline / fetch_hfq_daily JSON 路径；省略则读 stdin",
    )
    parser.add_argument(
        "--period",
        choices=["D", "W", "M", "all"],
        default="all",
        help="D 日 / W 周 / M 月 / all 三者（默认 all）",
    )
    parser.add_argument("--window", type=int, help="覆盖默认窗口")
    parser.add_argument("--nbdev", type=float, help="覆盖默认标准差倍数")
    args = parser.parse_args()

    try:
        payload = load_payload(args.input)
        bars = to_bars(payload)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1

    meta = payload if isinstance(payload, dict) else {}
    periods = ["D", "W", "M"] if args.period == "all" else [args.period]
    result: dict[str, Any] = {
        "ts_code": meta.get("ts_code") or meta.get("symbol"),
        "adj": meta.get("adj") or "backward/hfq",
        "bands": {},
    }

    for p in periods:
        defaults = DEFAULTS[p]
        window = args.window or defaults["window"]
        nbdev = args.nbdev if args.nbdev is not None else defaults["nbdev"]
        series = resample_closes(bars, p)
        result["bands"][p] = {
            "period": p,
            **bollinger(series, window, nbdev),
        }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
