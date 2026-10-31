"""Collect data and promote a validated global model locally.

This is deliberately an opt-in, one-shot job. Run it from a scheduler after
deciding the symbol list and interval in the environment; it never changes a
model unless the candidate is no worse than the current model on both tracked
test metrics. The model remains a single pooled model for all symbols.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def metric(metadata: dict, name: str, default: float) -> float:
    value = metadata.get("metrics", {}).get(name, default)
    return float(value) if isinstance(value, (int, float)) else default


def run_module(module: str, args: list[str]) -> None:
    command = [sys.executable, "-m", module, *args]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Retrain and promote the global KEEL prediction model")
    parser.add_argument("--symbols", default=os.getenv("PREDICTION_SYMBOLS", "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT"))
    parser.add_argument("--interval", choices=["15m", "1h", "4h", "1d"], default=os.getenv("PREDICTION_INTERVAL", "1h"))
    parser.add_argument("--start-time", type=int, default=int(os.getenv("PREDICTION_START_TIME", "1704067200000")))
    parser.add_argument("--data-dir", type=Path, default=Path(os.getenv("PREDICTION_DATA_DIR", "data")))
    parser.add_argument("--model-root", type=Path, default=Path(os.getenv("PREDICTION_MODEL_DIR", "prediction/models")))
    parser.add_argument("--min-accuracy", type=float, default=float(os.getenv("PREDICTION_MIN_ACCURACY", "0.8")))
    parser.add_argument("--min-test-samples", type=int, default=int(os.getenv("PREDICTION_MIN_TEST_SAMPLES", "500")))
    args = parser.parse_args()
    symbols = sorted({item.strip().upper() for item in args.symbols.split(",") if item.strip()})
    if len(symbols) < 2:
        parser.error("通用模型至少需要两个交易对")
    args.data_dir.mkdir(parents=True, exist_ok=True)
    args.model_root.mkdir(parents=True, exist_ok=True)
    target = args.model_root / args.interval
    backup = args.model_root / f"{args.interval}.previous"
    if backup.exists() and not target.exists():
        backup.rename(target)
    input_paths: list[str] = []
    for symbol in symbols:
        output_path = args.data_dir / f"{symbol}-{args.interval}.csv"
        run_module("prediction.collect_klines", [
            "--symbol", symbol, "--interval", args.interval,
            "--start-time", str(args.start_time),
            "--output", str(output_path),
        ])
        input_paths.append(str(output_path))

    with tempfile.TemporaryDirectory(prefix="keel-model-") as temporary:
        candidate = Path(temporary) / args.interval
        run_module("prediction.train", [
            "--input", *input_paths, "--interval", args.interval,
            "--horizon-bars", os.getenv("PREDICTION_HORIZON_BARS", "3"),
            "--output-dir", str(candidate),
        ])
        metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
        accuracy = metric(metadata, "accuracy", 0.0)
        brier = metric(metadata, "brier", float("inf"))
        test_samples = int(metadata.get("metrics", {}).get("testSamples", 0))
        if accuracy < args.min_accuracy or test_samples < args.min_test_samples:
            raise SystemExit(f"候选模型未达到门槛：accuracy={accuracy:.4f}, testSamples={test_samples}")
        current_metadata_path = target / "metadata.json"
        if current_metadata_path.exists():
            current = json.loads(current_metadata_path.read_text(encoding="utf-8"))
            current_accuracy = metric(current, "accuracy", 0.0)
            current_brier = metric(current, "brier", float("inf"))
            if accuracy < current_accuracy or brier > current_brier:
                raise SystemExit(f"候选模型未优于当前模型：accuracy={accuracy:.4f}/{current_accuracy:.4f}, brier={brier:.4f}/{current_brier:.4f}")
        # Prepare the complete candidate beside the live model first.  Moving
        # directories is atomic on the same volume, so a failed promotion can
        # restore the previous model instead of leaving the service without a
        # model.
        staged = args.model_root / f".{args.interval}.staged-{os.getpid()}"
        backup = args.model_root / f"{args.interval}.previous"
        if staged.exists():
            shutil.rmtree(staged)
        if backup.exists():
            shutil.rmtree(backup)
        shutil.copytree(candidate, staged)
        had_target = target.exists()
        if had_target:
            target.rename(backup)
        try:
            staged.rename(target)
        except Exception:
            if had_target and backup.exists() and not target.exists():
                backup.rename(target)
            raise
        finally:
            if staged.exists():
                shutil.rmtree(staged, ignore_errors=True)
        print(f"promoted global {args.interval} model: accuracy={accuracy:.4f}, brier={brier:.4f}")


if __name__ == "__main__":
    main()
