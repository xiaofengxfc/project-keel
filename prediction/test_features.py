import unittest

from prediction.features import build_training_rows, feature_row, normalize_candles


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
        self.assertEqual(len(feature_row(candles)), 16)
        features, labels, returns = build_training_rows(candles, 3)
        self.assertEqual(len(features), len(labels))
        self.assertEqual(len(labels), len(returns))
        self.assertGreater(len(labels), 0)

    def test_binance_array_input_is_supported(self):
        rows = [[index, 100, 101, 99, 100, 10] for index in range(60)]
        self.assertEqual(len(normalize_candles(rows)), 60)


if __name__ == "__main__":
    unittest.main()

