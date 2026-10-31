import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from prediction.training_worker import atomic_json, final_job_phase, is_not_promoted, local_reload_url, load_progress, run_interval, short_error


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

    def test_short_error_prefers_original_cause_over_subprocess_wrapper(self):
        output = (
            "Traceback (most recent call last):\n"
            '  File "training_progress.py", line 20, in report_progress\n'
            "PermissionError: [WinError 5] Access is denied\n"
            "Traceback (most recent call last):\n"
            "subprocess.CalledProcessError: Command returned non-zero exit status 1.\n"
        )
        self.assertEqual(short_error(output, 1), "PermissionError: [WinError 5] Access is denied")

    def test_short_error_removes_ansi_color_sequences(self):
        output = "\x1b[1;35mRuntimeError\x1b[0m: \x1b[35mtraining failed\x1b[0m"
        self.assertEqual(short_error(output, 1), "RuntimeError: training failed")

    def test_worker_prefers_current_progress_line_over_stale_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            progress_path = root / "progress.json"
            log_path = root / "training.log"
            state = {"jobId": "job-1", "intervalResults": {}}
            current_progress = {
                "jobId": "job-1", "phase": "collecting", "interval": "15m",
                "currentSymbol": "ETHUSDT", "pagesFetched": 2, "rowsFetched": 200,
            }

            class FakeProcess:
                def __init__(self):
                    self.stdout = iter(["KEEL_TRAIN_PROGRESS " + json.dumps(current_progress) + "\n"])

                def wait(self):
                    return 1

            def start_process(*_args, **_kwargs):
                progress_path.write_text(json.dumps({
                    "jobId": "job-1", "phase": "collecting", "interval": "15m",
                    "currentSymbol": "BTCUSDT", "pagesFetched": 1, "rowsFetched": 100,
                }), encoding="utf-8")
                return FakeProcess()

            with patch("prediction.training_worker.subprocess.Popen", side_effect=start_process):
                run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertEqual(state["rowsFetched"], 200)
            self.assertEqual(state["pagesFetched"], 2)

    def test_only_local_prediction_endpoints_are_reloaded(self):
        self.assertEqual(local_reload_url("http://127.0.0.1:8790/predict"), "http://127.0.0.1:8790/reload")
        self.assertIsNone(local_reload_url("https://prediction.example/predict"))

    def test_job_phase_distinguishes_unpromoted_from_failed_training(self):
        self.assertEqual(final_job_phase({"15m": {"phase": "not-promoted"}}, ["15m"]), "not-promoted")
        self.assertEqual(final_job_phase({"15m": {"phase": "failed"}}, ["15m"]), "failed")
        self.assertEqual(final_job_phase({"15m": {"phase": "completed"}, "1h": {"phase": "failed"}}, ["15m", "1h"]), "partial")


if __name__ == "__main__":
    unittest.main()
