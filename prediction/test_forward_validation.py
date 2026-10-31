import tempfile
import time
import unittest
from pathlib import Path

from prediction.features import Candle
from prediction.service import ForwardValidationStore, outcome_neutral_threshold, validation_metrics


def candles(start: int, closes: list[float]) -> list[Candle]:
    return [Candle(time=start + index * 3600, open=close, high=close * 1.001, low=close * 0.999, close=close, volume=10.0) for index, close in enumerate(closes)]


class ForwardValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = ForwardValidationStore(Path(self.temp_dir.name) / "forward.sqlite3")

    def tearDown(self):
        self.temp_dir.cleanup()

    def record(self, symbol: str, horizon: int, predicted: int, origin: int = 10_000, generated_at: int = 1_800_000_000, version: str = "test-v1"):
        self.store.record(
            symbol=symbol,
            interval="1h",
            horizon_bars=horizon,
            data_through=origin,
            origin_close=100.0,
            probabilities=[0.1, 0.1, 0.8] if predicted == 2 else [0.8, 0.1, 0.1],
            predicted_label=predicted,
            neutral_threshold=0.0015,
            model_version=version,
            generated_at=generated_at,
        )

    def test_pending_prediction_settles_at_its_exact_horizon_and_metrics_are_aggregated(self):
        self.record("BTCUSDT", horizon=2, predicted=2)
        before = self.store.metrics(symbol="BTCUSDT", interval="1h", horizon_bars=2)
        self.assertEqual((before["predictions"], before["settled"], before["pending"]), (1, 0, 1))

        # An unrelated symbol and horizon must not settle this forecast.
        self.store.settle("ETHUSDT", "1h", candles(10_000, [100.0, 100.0, 103.0]))
        self.store.settle("BTCUSDT", "1h", candles(10_000, [100.0, 100.0, 103.0]))
        metrics = self.store.metrics(symbol="BTCUSDT", interval="1h", horizon_bars=2)
        self.assertEqual((metrics["settled"], metrics["pending"], metrics["accuracy"]), (1, 0, 1.0))
        self.assertEqual(metrics["byClass"]["UP"]["actual"], 1)
        self.assertNotIn("origin_close", metrics)
        self.assertNotIn("probability_up", metrics)

    def test_threshold_matches_trainer_floor_and_atr_adjustment(self):
        calm = candles(10_000, [100.0] * 50)
        volatile = [Candle(time=10_000 + index * 3600, open=100.0, high=110.0, low=90.0, close=100.0, volume=10.0) for index in range(50)]
        self.assertEqual(outcome_neutral_threshold(calm), 0.0015)
        self.assertGreater(outcome_neutral_threshold(volatile), 0.0015)

    def test_optional_filters_return_only_matching_aggregate(self):
        self.record("BTCUSDT", horizon=1, predicted=2)
        self.record("ETHUSDT", horizon=1, predicted=0, origin=20_000)
        self.store.settle("BTCUSDT", "1h", candles(10_000, [100.0, 103.0]))
        btc = self.store.metrics(symbol="BTCUSDT", interval="1h", horizon_bars=1)
        all_rows = self.store.metrics()
        self.assertEqual(btc["predictions"], 1)
        self.assertEqual(all_rows["predictions"], 2)
        self.assertEqual(all_rows["settled"], 1)

    def test_metrics_read_expires_old_pending_forecasts_but_keeps_recent_ones(self):
        now = int(time.time())
        self.store.retention_days = 1
        self.record("BTCUSDT", horizon=3, predicted=2, generated_at=now - 86_401)
        self.record("ETHUSDT", horizon=3, predicted=2, origin=20_000, generated_at=now - 60)

        metrics = self.store.metrics()

        self.assertEqual((metrics["predictions"], metrics["settled"], metrics["pending"]), (1, 0, 1))
        self.assertEqual(self.store.metrics(symbol="BTCUSDT")["predictions"], 0)
        self.assertEqual(self.store.metrics(symbol="ETHUSDT")["pending"], 1)

    def test_metrics_keep_model_versions_separate(self):
        self.record("BTCUSDT", horizon=1, predicted=2, version="model-v1")
        self.record("BTCUSDT", horizon=1, predicted=0, origin=20_000, version="model-v2")
        self.store.settle("BTCUSDT", "1h", candles(10_000, [100.0, 103.0]))
        self.store.settle("BTCUSDT", "1h", candles(20_000, [100.0, 97.0]))

        metrics = self.store.metrics(symbol="BTCUSDT", interval="1h", horizon_bars=1)

        self.assertEqual(metrics["settled"], 2)
        self.assertEqual(metrics["byModelVersion"]["model-v1"]["accuracy"], 1.0)
        self.assertEqual(metrics["byModelVersion"]["model-v2"]["accuracy"], 1.0)
        self.assertEqual(metrics["byModelVersion"]["model-v1"]["settled"], 1)

    def test_read_only_metrics_route_exposes_no_raw_prediction_records(self):
        import prediction.service as service

        previous = service.validation_store
        try:
            service.validation_store = self.store
            payload = validation_metrics(symbol="BTCUSDT", interval="1h", horizonBars=2)
            self.assertEqual(payload["predictions"], 0)
            self.assertEqual(set(payload), {"predictions", "settled", "pending", "accuracy", "balancedAccuracy", "brier", "averageReturnPct", "byModelVersion"})
        finally:
            service.validation_store = previous


if __name__ == "__main__":
    unittest.main()
