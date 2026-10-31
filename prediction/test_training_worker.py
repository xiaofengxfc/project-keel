import json
import tempfile
import unittest
from pathlib import Path

from prediction.training_worker import atomic_json, final_job_phase, is_not_promoted, local_reload_url, load_progress, short_error


class TrainingWorkerTests(unittest.TestCase):
    def test_progress_snapshot_is_atomic_json_and_job_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            atomic_json(path, {"jobId": "job-1", "phase": "collecting", "currentSymbol": "BTCUSDT"})
            self.assertEqual(load_progress(path, "job-1")["currentSymbol"], "BTCUSDT")
            self.assertEqual(load_progress(path, "job-2"), {})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["phase"], "collecting")

    def test_failed_candidate_is_classified_separately_from_training_failure(self):
        output = "NOT_PROMOTED: candidate did not improve"
        self.assertTrue(is_not_promoted(3, output))
        self.assertFalse(is_not_promoted(1, "Traceback: network failure"))
        self.assertEqual(short_error(output, 3), "candidate did not improve")

    def test_only_local_prediction_endpoints_are_reloaded(self):
        self.assertEqual(local_reload_url("http://127.0.0.1:8790/predict"), "http://127.0.0.1:8790/reload")
        self.assertIsNone(local_reload_url("https://prediction.example/predict"))

    def test_job_phase_distinguishes_unpromoted_from_failed_training(self):
        self.assertEqual(final_job_phase({"15m": {"phase": "not-promoted"}}, ["15m"]), "not-promoted")
        self.assertEqual(final_job_phase({"15m": {"phase": "failed"}}, ["15m"]), "failed")
        self.assertEqual(final_job_phase({"15m": {"phase": "completed"}, "1h": {"phase": "failed"}}, ["15m", "1h"]), "partial")


if __name__ == "__main__":
    unittest.main()
