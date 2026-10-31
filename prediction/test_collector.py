import csv
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from prediction.collect_klines import fetch_page, main


def candle(timestamp: int, close: float = 100.0):
    return [timestamp, str(close), str(close + 1), str(close - 1), str(close), "10"]


class CollectorTests(unittest.TestCase):
    def test_existing_csv_is_reused_and_recent_rows_are_refreshed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "BTCUSDT-1h.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["time", "open", "high", "low", "close", "volume"])
                writer.writerows([candle(1000), candle(2000), candle(3000)])
            latest = [candle(2000, 101), candle(3000, 102), candle(4000, 103)]
            output = io.StringIO()
            with patch("sys.argv", ["collect_klines", "--symbol", "BTCUSDT", "--interval", "1h", "--output", str(path), "--start-time", "1000", "--end-time", "4000"]), patch("prediction.collect_klines.fetch_page", return_value=latest) as fetch, redirect_stdout(output):
                main()
            self.assertEqual(fetch.call_count, 1)
            with path.open("r", newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([int(row["time"]) for row in rows], [1000, 2000, 3000, 4000])
            self.assertEqual(float(rows[2]["close"]), 102.0)
            self.assertIn("KEEL_TRAIN_PROGRESS", output.getvalue())

    def test_successful_pages_are_checkpointed_before_a_later_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "BTCUSDT-1h.csv"
            page = [candle(index * 3_600_000) for index in range(1, 1001)]
            with patch("sys.argv", ["collect_klines", "--symbol", "BTCUSDT", "--interval", "1h", "--output", str(path), "--start-time", "1"]), patch("prediction.collect_klines.fetch_page", side_effect=[page, RuntimeError("network down")]), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "network down"):
                    main()
            with path.open("r", newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 1000)

    def test_incomplete_existing_file_fills_missing_older_history_on_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "BTCUSDT-1h.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["time", "open", "high", "low", "close", "volume"])
                writer.writerow(candle(3000))
            pages = [[candle(3000, 101), candle(4000, 102)], [candle(1000), candle(2000)]]
            with patch("sys.argv", ["collect_klines", "--symbol", "BTCUSDT", "--interval", "1h", "--output", str(path), "--start-time", "1000", "--end-time", "4000"]), patch("prediction.collect_klines.fetch_page", side_effect=pages) as fetch, redirect_stdout(io.StringIO()):
                main()
            self.assertEqual(fetch.call_count, 2)
            with path.open("r", newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([int(row["time"]) for row in rows], [1000, 2000, 3000, 4000])

    def test_fetch_page_retries_rate_limit(self):
        from urllib.error import HTTPError

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"[]"

        with patch("prediction.collect_klines.urllib.request.urlopen", side_effect=[HTTPError("https://example.test", 429, "rate limited", {}, None), Response()]) as request, patch("prediction.collect_klines.time.sleep"):
            self.assertEqual(fetch_page("https://example.test", "BTCUSDT", "1h", None, retries=1), [])
            self.assertEqual(request.call_count, 2)


if __name__ == "__main__":
    unittest.main()
