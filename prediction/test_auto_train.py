import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch

from prediction.auto_train import candidate_status, run_collector, run_module, silent_process_options


class AutoTrainPromotionTests(unittest.TestCase):
    def test_silent_process_options_uses_windows_no_console_flag(self):
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True):
            self.assertEqual(silent_process_options(), {"creationflags": 0x08000000})
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0, create=True):
            self.assertEqual(silent_process_options(), {})

    def test_run_module_reports_child_output_before_raising(self):
        class FakeProcess:
            stdout = iter(["RuntimeError: Binance K 线请求失败\n"])

            def wait(self):
                return 1

        with patch("prediction.auto_train.subprocess.Popen", return_value=FakeProcess()), patch(
            "prediction.auto_train.report_progress"
        ) as report:
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                run_module("prediction.collect_klines", ["--symbol", "HMSTRUSDT"])

        self.assertEqual(raised.exception.returncode, 1)
        self.assertIn("RuntimeError: Binance K 线请求失败", raised.exception.output)
        report.assert_called_once()
        self.assertIn("Binance K 线请求失败", report.call_args.kwargs["error"])

    def test_run_collector_retries_failed_collection(self):
        failure = subprocess.CalledProcessError(1, ["python", "-m", "prediction.collect_klines"])
        with patch("prediction.auto_train.run_module", side_effect=[failure, failure, None]), patch(
            "prediction.auto_train.report_progress"
        ) as report, patch("prediction.auto_train.time.sleep") as sleep:
            run_collector("HMSTRUSDT", "15m", 1_700_000_000_000, Path("data/HMSTRUSDT-15m.csv"), 2, 20)

        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(report.call_count, 2)
        self.assertIn("正在重试", report.call_args.kwargs["message"])

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
