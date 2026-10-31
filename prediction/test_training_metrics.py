import unittest

from prediction.train import apply_temperature, calibrate_temperature, classification_metrics, feature_indices_for_model, log_loss


class TrainingMetricsTests(unittest.TestCase):
    def test_temperature_is_fit_only_as_a_probability_transform(self):
        probabilities = [[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [0.7, 0.2, 0.1]]
        labels = [0, 1, 2, 1]
        temperature = calibrate_temperature(probabilities, labels)
        self.assertGreater(temperature, 0)
        calibrated = apply_temperature(probabilities, temperature)
        self.assertTrue(all(abs(sum(row) - 1.0) < 1e-9 for row in calibrated))
        self.assertLessEqual(log_loss(calibrated, labels), log_loss(probabilities, labels))

    def test_metrics_include_class_balanced_and_selective_views(self):
        probabilities = [[0.8, 0.1, 0.1], [0.1, 0.7, 0.2], [0.6, 0.2, 0.2], [0.2, 0.2, 0.6]]
        metrics = classification_metrics(probabilities, [0, 1, 1, 2])
        self.assertEqual(metrics["accuracy"], 0.75)
        self.assertIn("balancedAccuracy", metrics)
        self.assertIn("macroF1", metrics)
        self.assertEqual(metrics["confidenceCoverage"], 1.0)
        self.assertGreaterEqual(metrics["selectiveAccuracy"], 0.0)

    def test_balanced_accuracy_averages_only_present_test_classes(self):
        probabilities = [[0.8, 0.1, 0.1], [0.2, 0.2, 0.6], [0.1, 0.7, 0.2]]
        metrics = classification_metrics(probabilities, [0, 0, 1])
        self.assertAlmostEqual(metrics["balancedAccuracy"], 0.75)

    def test_incumbent_feature_schema_can_be_aligned_by_name(self):
        names = ["return_1", "return_3", "range_pct"]
        self.assertEqual(feature_indices_for_model(names, ["range_pct", "return_1"]), [2, 0])
        self.assertIsNone(feature_indices_for_model(names, ["unknown_feature"]))


if __name__ == "__main__":
    unittest.main()
