import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from prediction.training_progress import report_progress


class TrainingProgressTests(unittest.TestCase):
    def test_transient_replace_permission_error_is_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            original_replace = os.replace
            calls = 0

            def replace_with_one_transient_failure(source, target):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise PermissionError(5, "Access is denied")
                return original_replace(source, target)

            with patch.dict(os.environ, {"PREDICTION_TRAINING_PROGRESS_FILE": str(path)}), patch(
                "prediction.training_progress.os.replace", side_effect=replace_with_one_transient_failure
            ), patch("prediction.training_progress.time.sleep") as sleep:
                report_progress("collecting", interval="15m", rowsFetched=1000)

            self.assertEqual(calls, 2)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["rowsFetched"], 1000)
            sleep.assert_called_once()

    def test_unwritable_progress_file_does_not_abort_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.dict(os.environ, {"PREDICTION_TRAINING_PROGRESS_FILE": str(path)}), patch(
                "prediction.training_progress.os.replace", side_effect=PermissionError(5, "Access is denied")
            ), patch("prediction.training_progress.time.sleep"):
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    state = report_progress("collecting", interval="15m")

            self.assertEqual(state["phase"], "collecting")
            self.assertIn("KEEL_TRAIN_PROGRESS", stdout.getvalue())
            self.assertIn("unable to persist training progress", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
