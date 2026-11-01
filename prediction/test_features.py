import unittest

from prediction.features import FEATURE_NAMES, _feature_row_at, build_training_rows, feature_row, normalize_candles
from prediction.train import purged_time_splits


def sample_candles(count: int = 80):
    return [{
        "time": index * 3_600,
        "open": 100 + index * 0.1,
        "high": 101 + index * 0.1,
        "low": 99 + index * 0.1,
        "close": 100.2 + index * 0.1,
        "volume": 100 + index,
    } for index in range(count)]


class FeatureTests(unittest.TestCase):
    def test_feature_vector_is_finite_and_training_is_time_ordered(self):
        candles = normalize_candles(sample_candles())
        self.assertEqual(len(feature_row(candles)), len(FEATURE_NAMES))
        features, labels, returns = build_training_rows(candles, 3)
        self.assertEqual(len(features), len(labels))
        self.assertEqual(len(labels), len(returns))
        self.assertGreater(len(labels), 0)

    def test_multi_scale_features_are_finite_and_shared_with_live_inference(self):
        candles = normalize_candles(sample_candles(120))
        self.assertEqual(len(feature_row(candles)), len(FEATURE_NAMES))
        self.assertTrue({"return_50", "realized_volatility20", "realized_volatility50", "rolling_range_pct20", "volume_zscore20", "trend_momentum_5_20"}.issubset(FEATURE_NAMES))
        features, _, _ = build_training_rows(candles, 3)
        self.assertEqual(len(features[-1]), len(FEATURE_NAMES))

    def test_training_rows_match_prefix_feature_rows(self):
        candles = normalize_candles(sample_candles(140))
        features, labels, returns = build_training_rows(candles, 3)
        for row_number, index in enumerate(range(49, len(candles) - 3)):
            expected = feature_row(candles[:index + 1])
            actual, _ = _feature_row_at(candles, index)
            for expected_value, actual_value in zip(expected, actual):
                self.assertAlmostEqual(expected_value, actual_value, places=15)
            expected_return = candles[index + 3].close / candles[index].close - 1.0
            self.assertAlmostEqual(returns[row_number], expected_return, places=15)
            self.assertEqual(len(labels), len(features))

    def test_purged_chronological_folds_prevent_horizon_label_overlap(self):
        row_times = list(range(30))
        label_end_times = [time + 3 for time in row_times]
        train, validation, test, validation_start, test_start = purged_time_splits(row_times, label_end_times, 0.2, 0.2)
        self.assertTrue(all(row_times[index] < validation_start and label_end_times[index] < validation_start for index in train))
        self.assertTrue(all(validation_start <= row_times[index] < test_start and label_end_times[index] < test_start for index in validation))
        self.assertTrue(all(row_times[index] >= test_start for index in test))

    def test_binance_array_input_is_supported(self):
        rows = [[index, 100, 101, 99, 100, 10] for index in range(60)]
        self.assertEqual(len(normalize_candles(rows)), 60)


if __name__ == "__main__":
    unittest.main()

