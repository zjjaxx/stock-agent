#!/usr/bin/env python3
"""拉取 A 股日线后复权行情（Tushare pro_bar）。

文档: https://tushare.pro/document/2?doc_id=146

用法:
  export TUSHARE_TOKEN=your_token
  python3 fetch_hfq_daily.py 600900.SH
  python3 fetch_hfq_daily.py 600900.SH --start 20240101 --end 20241231
  python3 fetch_hfq_daily.py 000001.SZ -o /tmp/000001_hfq.json

依赖: pip install tushare pandas
权限: pro_bar / adj_factor 约需 2000 积分；daily 约 120 积分。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def normalize_ts_code(code: str) -> str:
    raw = code.strip().upper()
    if not raw:
        raise ValueError("股票代码不能为空")
    if len(raw) == 9 and raw[6] == "." and raw[7:] in {"SH", "SZ", "BJ"}:
        return raw
    if len(raw) == 8 and raw[:2] in {"SH", "SZ", "BJ"}:
        return f"{raw[2:]}.{raw[:2]}"
    if len(raw) == 6 and raw.isdigit():
        head = raw[0]
        if head in {"6", "9"}:
            return f"{raw}.SH"
        if head in {"0", "3"}:
            return f"{raw}.SZ"
        if head in {"4", "8"}:
            return f"{raw}.BJ"
        raise ValueError(f"无法推断交易所: {raw}，请使用如 600900.SH")
    raise ValueError(f"无效代码: {code}，请使用 600900.SH / 000001.SZ / 6位数字")


def fetch_hfq_daily(
    ts_code: str,
    start_date: str | None,
    end_date: str | None,
    token: str,
) -> list[dict[str, Any]]:
    try:
        import tushare as ts
    except ImportError as exc:
        raise RuntimeError("未安装 tushare，请执行: pip install tushare pandas") from exc

    pro = ts.pro_api(token)
    kwargs: dict[str, Any] = {
        "ts_code": ts_code,
        "api": pro,
        "adj": "hfq",
        "freq": "D",
        "asset": "E",
    }
    if start_date:
        kwargs["start_date"] = start_date
    if end_date:
        kwargs["end_date"] = end_date

    try:
        df = ts.pro_bar(**kwargs)
    except OSError as exc:
        # SDK 常把内部异常吞成 OSError('ERROR.')；补一句可读提示
        raise RuntimeError(
            "pro_bar 调用失败（常见原因：adj_factor 无权限/约需2000积分，"
            "或 token 无效）。原始错误: ERROR. "
            "文档: https://tushare.pro/document/2?doc_id=146"
        ) from exc

    if df is None or getattr(df, "empty", True):
        raise RuntimeError(
            "pro_bar 返回空。请检查代码/日期，或 token 是否具备复权权限"
            "（daily≈120、adj_factor≈2000 积分）"
        )

    if "trade_date" not in df.columns:
        df = df.reset_index()

    df = df.sort_values("trade_date")
    records = json.loads(df.to_json(orient="records", force_ascii=False))
    return records


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Tushare pro_bar 拉取 A 股日线后复权（adj=hfq, freq=D）"
    )
    parser.add_argument("ts_code", help="股票代码，如 600900.SH / 000001 / 000001.SZ")
    parser.add_argument("--start", dest="start_date", help="开始日期 YYYYMMDD")
    parser.add_argument("--end", dest="end_date", help="结束日期 YYYYMMDD")
    parser.add_argument(
        "-o",
        "--output",
        help="写入 JSON 文件路径；默认打印到 stdout",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("TUSHARE_TOKEN", ""),
        help="Tushare token；默认读环境变量 TUSHARE_TOKEN",
    )
    args = parser.parse_args()

    if not args.token:
        print(
            json.dumps(
                {"error": "未提供 token：请设置环境变量 TUSHARE_TOKEN 或传 --token"},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    try:
        ts_code = normalize_ts_code(args.ts_code)
        bars = fetch_hfq_daily(
            ts_code=ts_code,
            start_date=args.start_date,
            end_date=args.end_date,
            token=args.token,
        )
    except Exception as exc:  # noqa: BLE001 — CLI 统一 JSON 错误出口
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1

    payload = {
        "ts_code": ts_code,
        "adj": "hfq",
        "freq": "D",
        "asset": "E",
        "source": "tushare.pro_bar",
        "api_doc": "https://tushare.pro/document/2?doc_id=146",
        "start_date": args.start_date,
        "end_date": args.end_date,
        "count": len(bars),
        "bars": bars,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.write("\n")
        print(json.dumps({"savedTo": args.output, "count": len(bars)}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
