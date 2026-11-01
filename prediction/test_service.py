import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from prediction.service import ModelState


class _FakeBundle:
    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.session = object()
        self.load_error = ""
        self.metadata = {
            "interval": model_dir.parent.name,
            "symbol": model_dir.name,
        }

    @property
    def ready(self):
        return True


class ModelStateTests(unittest.TestCase):
    def test_loads_only_exact_interval_and_symbol_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for interval, symbol in (("1h", "BTCUSDT"), ("1h", "ETHUSDT"), ("15m", "BTCUSDT")):
                model_dir = root / interval / symbol
                model_dir.mkdir(parents=True)

            with patch.dict(os.environ, {"PREDICTION_MODEL_DIR": str(root)}), patch("prediction.service.ModelBundle", _FakeBundle):
                state = ModelState()

            self.assertEqual(set(state.bundles), {("1h", "BTCUSDT"), ("1h", "ETHUSDT"), ("15m", "BTCUSDT")})
            self.assertIsNotNone(state.bundle_for("1h", "BTCUSDT"))
            self.assertIsNone(state.bundle_for("4h", "BTCUSDT"))
            self.assertIsNone(state.bundle_for("1h", "SOLUSDT"))

    def test_reload_replaces_snapshot_after_model_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_dir = root / "1h" / "BTCUSDT"
            model_dir.mkdir(parents=True)

            with patch.dict(os.environ, {"PREDICTION_MODEL_DIR": str(root)}), patch("prediction.service.ModelBundle", _FakeBundle):
                state = ModelState()
                self.assertTrue(state.ready)
                for child in model_dir.iterdir():
                    child.unlink()
                model_dir.rmdir()
                model_dir.parent.rmdir()
                self.assertIsNotNone(state.load())

            self.assertFalse(state.ready)
            self.assertEqual(state.bundles, {})
            self.assertIsNone(state.bundle_for("1h", "BTCUSDT"))


if __name__ == "__main__":
    unittest.main()
