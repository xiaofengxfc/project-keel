"""Download paginated USDⓈ-M Futures candles into a CSV file.

The collector uses only the standard library and can use the same HTTPS proxy
as Node through HTTPS_PROXY. It paginates backwards so an end date can be
provided without requiring a separate database.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


INTERVAL_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}


def fetch_page(base_url: str, symbol: str, interval: str, end_time: int | None) -> list[list[object]]:
    params = {"symbol": symbol, "interval": interval, "limit": "1000"}
    if end_time is not None:
        params["endTime"] = str(end_time)
    url = f"{base_url.rstrip('/')}/fapi/v1/klines?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "keel-prediction-collector/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list) or any(not isinstance(row, list) or len(row) < 6 for row in payload):
        raise RuntimeError("Binance returned an invalid kline payload")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect Binance USDⓈ-M Futures klines")
    parser.add_argument("--symbol", required=True, help="例如 BTCUSDT")
    parser.add_argument("--interval", choices=sorted(INTERVAL_MS), required=True)
    parser.add_argument("--output", required=True, help="输出 CSV 文件")
    parser.add_argument("--base-url", default=os.getenv("BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com"))
    parser.add_argument("--start-time", type=int, help="起始 Unix 毫秒时间")
    parser.add_argument("--end-time", type=int, help="结束 Unix 毫秒时间，默认当前时间")
    parser.add_argument("--sleep", type=float, default=0.2, help="请求间隔秒数")
    args = parser.parse_args()
    symbol = args.symbol.upper()
    end_time = args.end_time or int(time.time() * 1000)
    start_time = args.start_time or 0
    interval_ms = INTERVAL_MS[args.interval]
    rows: list[list[object]] = []
    while end_time >= start_time:
        page = fetch_page(args.base_url, symbol, args.interval, end_time)
        if not page:
            break
        rows.extend(page)
        first_open = int(page[0][0])
        if first_open <= start_time or len(page) < 1000:
            break
        end_time = first_open - 1
        time.sleep(max(0.0, args.sleep))
    unique = {int(row[0]): row for row in rows}
    selected = [row for timestamp, row in sorted(unique.items()) if start_time <= timestamp <= (args.end_time or int(time.time() * 1000))]
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time", "open", "high", "low", "close", "volume"])
        for row in selected:
            writer.writerow(row[:6])
    print(f"wrote {len(selected)} candles to {args.output} ({datetime.now(timezone.utc).isoformat()})")


if __name__ == "__main__":
    main()

