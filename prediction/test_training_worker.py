import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from prediction.training_worker import atomic_json, final_job_phase, is_not_promoted, local_reload_url, load_progress, main, record_worker_failure, run_interval, short_error, silent_process_options


class TrainingWorkerTests(unittest.TestCase):
    def test_silent_process_options_uses_windows_no_console_flag(self):
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True):
            self.assertEqual(silent_process_options(), {"creationflags": 0x08000000})
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0, create=True):
            self.assertEqual(silent_process_options(), {})

    def test_atomic_json_retries_transient_windows_replace_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            real_replace = os.replace
            calls = 0

            def replace_with_transient_lock(source, destination):
                nonlocal calls
                calls += 1
                if calls < 3:
                    raise PermissionError(5, "Access is denied")
                real_replace(source, destination)

            with patch("prediction.training_worker.os.replace", side_effect=replace_with_transient_lock), patch("prediction.training_worker.time.sleep") as sleep:
                atomic_json(path, {"phase": "running"})

            self.assertEqual(calls, 3)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["phase"], "running")
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_atomic_json_cleans_temporary_file_after_replace_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            temporary_paths = []

            def replace_always_locked(source, destination):
                temporary_paths.append(Path(source))
                raise PermissionError(5, "Access is denied")

            with patch("prediction.training_worker.os.replace", side_effect=replace_always_locked), patch("prediction.training_worker.time.sleep"):
                with self.assertRaises(PermissionError):
                    atomic_json(path, {"phase": "running"})

            self.assertEqual(len(temporary_paths), 4)
            self.assertTrue(all(not temporary.exists() for temporary in temporary_paths))
            self.assertFalse(path.exists())

    def test_unexpected_worker_failure_is_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            log_path = root / "training.log"
            atomic_json(state_path, {
                "jobId": "job-1", "running": True, "phase": "running",
                "currentInterval": "15m", "currentSymbol": "BTCUSDT",
                "intervalResults": {"15m": {"phase": "running", "error": None}},
                "workerPid": 123,
            })
            try:
                raise RuntimeError("unexpected training failure")
            except RuntimeError as error:
                record_worker_failure(state_path, log_path, error)

            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertFalse(state["running"])
            self.assertEqual(state["phase"], "failed")
            self.assertEqual(state["stage"], "worker-error")
            self.assertEqual(state["intervalResults"]["15m"]["phase"], "failed")
            self.assertEqual(state["finishedIntervals"], ["15m"])
            self.assertNotIn("workerPid", state)
            self.assertIn("RuntimeError: unexpected training failure", log_path.read_text(encoding="utf-8"))

    def test_main_catches_unexpected_worker_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            log_path = root / "training.log"
            atomic_json(state_path, {"jobId": "job-1", "running": True, "phase": "running", "workerPid": 123})
            argv = [
                "training_worker", "--job-id", "job-1", "--intervals", "15m",
                "--symbols", "BTCUSDT,ETHUSDT", "--state-file", str(state_path),
                "--progress-file", str(root / "progress.json"), "--log-file", str(log_path),
            ]
            with patch.object(sys, "argv", argv), patch("prediction.training_worker.run_worker", side_effect=RuntimeError("boom")):
                self.assertEqual(main(), 1)
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["stage"], "worker-error")
            self.assertIn("RuntimeError: boom", state["error"])

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
            process_kwargs = {}

            class FakeProcess:
                def __init__(self):
                    self.stdout = iter(["KEEL_TRAIN_PROGRESS " + json.dumps(current_progress) + "\n"])

                def wait(self):
                    return 1

            def start_process(*_args, **_kwargs):
                process_kwargs.update(_kwargs)
                progress_path.write_text(json.dumps({
                    "jobId": "job-1", "phase": "collecting", "interval": "15m",
                    "currentSymbol": "BTCUSDT", "pagesFetched": 1, "rowsFetched": 100,
                }), encoding="utf-8")
                return FakeProcess()

            with patch("prediction.training_worker.subprocess.Popen", side_effect=start_process):
                run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertEqual(state["rowsFetched"], 200)
            self.assertEqual(state["pagesFetched"], 2)
            self.assertEqual(process_kwargs["env"]["PYTHONIOENCODING"], "utf-8")

    def test_worker_keeps_candle_progress_when_next_symbol_resets_local_counter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            progress_path = root / "progress.json"
            log_path = root / "training.log"
            state = {"jobId": "job-1", "intervalResults": {}}
            lines = [
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "collecting", "symbolIndex": 1, "rowsFetched": 100, "pagesFetched": 1}),
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "collecting", "symbolIndex": 2, "currentSymbol": "ETHUSDT", "rowsFetched": 0, "pagesFetched": 0}),
            ]

            class FakeProcess:
                stdout = iter(f"{line}\n" for line in lines)

                def wait(self):
                    return 1

            with patch("prediction.training_worker.subprocess.Popen", return_value=FakeProcess()):
                run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertEqual(state["rowsFetched"], 100)
            self.assertEqual(state["pagesFetched"], 1)

    def test_worker_resets_collection_counter_before_training_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            progress_path = root / "progress.json"
            log_path = root / "training.log"
            state = {"jobId": "job-1", "intervalResults": {}}
            lines = [
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "collecting", "symbolIndex": 1, "rowsFetched": 100, "pagesFetched": 1}),
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "collecting", "symbolIndex": 2, "rowsFetched": 200, "pagesFetched": 2}),
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "preparing", "symbolIndex": 2, "rowsFetched": 1234, "pagesFetched": 0}),
                "KEEL_TRAIN_PROGRESS " + json.dumps({"jobId": "job-1", "phase": "fitting", "symbolIndex": 2, "rowsFetched": 1234, "pagesFetched": 0}),
            ]

            class FakeProcess:
                stdout = iter(f"{line}\n" for line in lines)

                def wait(self):
                    return 1

            with patch("prediction.training_worker.subprocess.Popen", return_value=FakeProcess()):
                run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertEqual(state["rowsFetched"], 1234)
            self.assertEqual(state["pagesFetched"], 0)

    def test_worker_preserves_machine_readable_child_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            progress_path = root / "progress.json"
            log_path = root / "training.log"
            state = {"jobId": "job-1", "intervalResults": {}}

            class FakeProcess:
                stdout = iter([
                    "KEEL_TRAIN_PROGRESS " + json.dumps({
                        "jobId": "job-1",
                        "phase": "failed",
                        "error": "prediction.collect_klines 子进程退出，代码 1：RuntimeError: Binance K 线请求失败",
                    }) + "\n",
                ])

                def wait(self):
                    return 1

            with patch("prediction.training_worker.subprocess.Popen", return_value=FakeProcess()):
                result = run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertEqual(result["phase"], "failed")
            self.assertIn("Binance K 线请求失败", result["error"])

    def test_worker_clears_stale_progress_error_after_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "state.json"
            progress_path = root / "progress.json"
            log_path = root / "training.log"
            state = {"jobId": "job-1", "intervalResults": {}}

            class FakeProcess:
                stdout = iter([
                    "KEEL_TRAIN_PROGRESS " + json.dumps({
                        "jobId": "job-1", "phase": "failed",
                        "error": "第一次采集失败",
                    }) + "\n",
                    "KEEL_TRAIN_PROGRESS " + json.dumps({
                        "jobId": "job-1", "phase": "preparing",
                    }) + "\n",
                    "RuntimeError: 第二次采集失败\n",
                ])

                def wait(self):
                    return 1

            with patch("prediction.training_worker.subprocess.Popen", return_value=FakeProcess()):
                result = run_interval("15m", ["BTCUSDT", "ETHUSDT"], "job-1", state_path, progress_path, log_path, state)

            self.assertIn("第二次采集失败", result["error"])
            self.assertNotIn("第一次采集失败", result["error"])

    def test_only_local_prediction_endpoints_are_reloaded(self):
        self.assertEqual(local_reload_url("http://127.0.0.1:8790/predict"), "http://127.0.0.1:8790/reload")
        self.assertIsNone(local_reload_url("https://prediction.example/predict"))

    def test_job_phase_distinguishes_unpromoted_from_failed_training(self):
        self.assertEqual(final_job_phase({"15m": {"phase": "not-promoted"}}, ["15m"]), "not-promoted")
        self.assertEqual(final_job_phase({"15m": {"phase": "failed"}}, ["15m"]), "failed")
        self.assertEqual(final_job_phase({"15m": {"phase": "completed"}, "1h": {"phase": "failed"}}, ["15m", "1h"]), "partial")


if __name__ == "__main__":
    unittest.main()
