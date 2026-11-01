import unittest
import subprocess
from unittest.mock import patch

from prediction.auto_train import candidate_status, silent_process_options


class AutoTrainPromotionTests(unittest.TestCase):
    def test_silent_process_options_uses_windows_no_console_flag(self):
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True):
            self.assertEqual(silent_process_options(), {"creationflags": 0x08000000})
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0, create=True):
            self.assertEqual(silent_process_options(), {})

    def setUp(self):
        self.candidate = {
            "featureNames": ["return_1", "return_3"],
            "metrics": {"testSamples": 600, "accuracy": 0.6, "balancedAccuracy": 0.55, "macroF1": 0.52, "brier": 0.58},
        }

    def test_first_model_requires_finite_metrics_and_enough_samples(self):
        self.assertIsNone(candidate_status(self.candidate, None, 500))
        self.assertIsNotNone(candidate_status(self.candidate, None, 700))

    def test_incomparable_incumbent_blocks_promotion_even_with_new_schema(self):
        current = {"featureNames": ["return_1"]}
        self.assertIsNotNone(candidate_status(self.candidate, current, 500))

    def test_candidate_must_improve_same_fold_brier_balanced_accuracy_and_f1(self):
        current = {"featureNames": ["return_1"]}
        self.candidate["baselineComparison"] = {
            "compatible": True,
            "metrics": {"brier": 0.6, "balancedAccuracy": 0.54, "macroF1": 0.51},
        }
        self.assertIsNone(candidate_status(self.candidate, current, 500))
        self.candidate["baselineComparison"]["metrics"]["macroF1"] = 0.53
        self.assertIn("宏 F1", candidate_status(self.candidate, current, 500))


if __name__ == "__main__":
    unittest.main()
