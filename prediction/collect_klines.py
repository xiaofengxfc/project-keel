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
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

from .training_progress import report_progress


INTERVAL_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}


def fetch_page(base_url: str, symbol: str, interval: str, end_time: int | None, retries: int = 3) -> list[list[object]]:
    params = {"symbol": symbol, "interval": interval, "limit": "1000"}
    if end_time is not None:
        params["endTime"] = str(end_time)
    url = f"{base_url.rstrip('/')}/fapi/v1/klines?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "keel-prediction-collector/1.0"})
    last_error: Exception | None = None
    for attempt in range(max(1, retries + 1)):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            status = getattr(error, "code", None)
            transient = status is None or status == 429 or int(status) >= 500
            if not transient or attempt >= retries:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                raise RuntimeError(f"Binance K 线请求失败（{symbol} {interval}，尝试 {attempt + 1} 次）：{error}") from error
            retry_after = 0.0
            headers = getattr(error, "headers", None)
            if headers is not None:
                try:
                    retry_after = max(0.0, float(headers.get("Retry-After", "0")))
                except (TypeError, ValueError):
                    retry_after = 0.0
            delay = min(60.0, max(1.0 * (2 ** attempt), retry_after))
            print(f"collector retry {symbol} {interval} in {delay:.1f}s: {error}", file=sys.stderr, flush=True)
            time.sleep(delay)
            if isinstance(error, urllib.error.HTTPError):
                error.close()
    else:
        raise RuntimeError(f"Binance K 线请求失败：{last_error}") from last_error
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
    parser.add_argument("--retries", type=int, default=int(os.getenv("PREDICTION_COLLECT_RETRIES", "3")), help="临时网络错误重试次数")
    parser.add_argument("--reuse-existing", action=argparse.BooleanOptionalAction, default=True, help="复用已有 CSV 并只补采缺失 K 线")
    args = parser.parse_args()
    symbol = args.symbol.upper()
    end_time = args.end_time or int(time.time() * 1000)
    start_time = args.start_time or 0
    interval_ms = INTERVAL_MS[args.interval]
    rows: list[list[object]] = []
    output_path = Path(args.output)
    if args.reuse_existing and output_path.exists():
        try:
            with output_path.open("r", newline="", encoding="utf-8") as handle:
                existing = list(csv.DictReader(handle))
            for row in existing:
                try:
                    timestamp = int(float(row["time"]))
                    rows.append([timestamp, row["open"], row["high"], row["low"], row["close"], row["volume"]])
                except (KeyError, TypeError, ValueError):
                    continue
        except OSError:
            rows = []
    existing_times = {int(row[0]) for row in rows}
    earliest_existing = min(existing_times) if existing_times else None
    latest_existing = max(existing_times) if existing_times else None
    pages_fetched = 0
    rows_fetched = 0

    def save_checkpoint(values: list[list[object]]) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint = output_path.with_name(f".{output_path.name}.checkpoint")
        with checkpoint.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["time", "open", "high", "low", "close", "volume"])
            unique_rows = {int(item[0]): item for item in values}
            for row in (unique_rows[timestamp] for timestamp in sorted(unique_rows)):
                writer.writerow(row[:6])
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(checkpoint, output_path)

    symbol_index = int(os.getenv("PREDICTION_TRAINING_SYMBOL_INDEX", "0") or 0)
    symbol_count = int(os.getenv("PREDICTION_TRAINING_SYMBOL_COUNT", "0") or 0)
    if args.retries < 0:
        parser.error("retries 必须是非负整数")

    def collect_range(cursor: int, lower_bound: int, *, stop_at_existing: int | None = None) -> None:
        nonlocal pages_fetched, rows_fetched
        while cursor >= lower_bound:
            report_progress("collecting", interval=args.interval, currentSymbol=symbol, symbolIndex=symbol_index, symbolCount=symbol_count, pagesFetched=pages_fetched, rowsFetched=len(rows), message=f"正在采集 {symbol} {args.interval} K 线")
            page = fetch_page(args.base_url, symbol, args.interval, cursor, args.retries)
            if not page:
                break
            pages_fetched += 1
            rows_fetched += len(page)
            rows.extend(page)
            save_checkpoint(rows)
            first_open = min(int(item[0]) for item in page)
            if stop_at_existing is not None and first_open <= stop_at_existing:
                break
            if first_open <= lower_bound or len(page) < 1000:
                break
            cursor = first_open - 1
            time.sleep(max(0.0, args.sleep))

    # Refresh the newest tail first, stopping once the cached newest candle is
    # reached. Then fill older history if a previous interrupted run had only
    # saved recent pages. This makes checkpointed downloads resumable.
    if latest_existing is None:
        collect_range(end_time, start_time)
    else:
        collect_range(end_time, latest_existing, stop_at_existing=latest_existing)
        if earliest_existing is not None and earliest_existing > start_time:
            collect_range(earliest_existing - 1, start_time)
    unique = {int(row[0]): row for row in rows}
    selected = [row for timestamp, row in sorted(unique.items()) if start_time <= timestamp <= (args.end_time or int(time.time() * 1000))]
    save_checkpoint(selected)
    report_progress("collecting", interval=args.interval, currentSymbol=symbol, symbolIndex=symbol_index, symbolCount=symbol_count, pagesFetched=pages_fetched, rowsFetched=len(selected), message=f"已完成 {symbol}：{len(selected)} 根 K 线")
    print(f"wrote {len(selected)} candles to {args.output} ({datetime.now(timezone.utc).isoformat()})")


if __name__ == "__main__":
    main()

