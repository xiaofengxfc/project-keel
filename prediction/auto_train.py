"""Collect data and promote a validated global model locally.

This is deliberately an opt-in, one-shot job. Run it from a scheduler after
deciding the symbol list and interval in the environment. Candidates are
compared against the incumbent on the same purged chronological test fold
when the incumbent feature schema can be aligned by name. The model remains
a single pooled model.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def metric(metadata: dict, name: str, default: float) -> float:
    value = metadata.get("metrics", {}).get(name, default)
    return float(value) if isinstance(value, (int, float)) else default


def finite_metric(metadata: dict, name: str, fallback: str | None = None) -> float | None:
    value = metadata.get("metrics", {}).get(name)
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        if fallback is None:
            return None
        value = metadata.get("metrics", {}).get(fallback)
    return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else None


def candidate_status(candidate: dict, current: dict | None, min_test_samples: int) -> str | None:
    metrics = candidate.get("metrics", {})
    test_samples = metrics.get("testSamples", 0)
    if not isinstance(test_samples, int) or test_samples < min_test_samples:
        return f"候选模型测试样本不足：{test_samples}<{min_test_samples}"
    candidate_accuracy = finite_metric(candidate, "accuracy")
    candidate_brier = finite_metric(candidate, "brier")
    candidate_balanced = finite_metric(candidate, "balancedAccuracy", "accuracy")
    candidate_f1 = finite_metric(candidate, "macroF1", "accuracy")
    values = (candidate_accuracy, candidate_brier, candidate_balanced, candidate_f1)
    if any(value is None for value in values):
        return "候选模型缺少有限的准确率、Brier、平衡准确率或宏 F1 指标"
    if not 0 <= candidate_accuracy <= 1 or not 0 <= candidate_brier <= 2 or not 0 <= candidate_balanced <= 1 or not 0 <= candidate_f1 <= 1:
        return "候选模型评估指标超出有效范围"
    if current is None:
        return None
    comparison = candidate.get("baselineComparison", {})
    comparison_metrics = comparison.get("metrics", {}) if comparison.get("compatible") is True else {}
    if comparison_metrics:
        baseline = {"metrics": comparison_metrics}
        baseline_brier = finite_metric(baseline, "brier")
        baseline_balanced = finite_metric(baseline, "balancedAccuracy", "accuracy")
        baseline_f1 = finite_metric(baseline, "macroF1", "accuracy")
        if baseline_brier is None or baseline_balanced is None or baseline_f1 is None or not 0 <= baseline_brier <= 2 or not 0 <= baseline_balanced <= 1 or not 0 <= baseline_f1 <= 1:
            return "同一未来测试集上的 incumbent 比较指标无效"
        if candidate_brier > baseline_brier:
            return f"候选模型 Brier 未改善：{candidate_brier:.4f}>{baseline_brier:.4f}"
        if candidate_balanced < baseline_balanced:
            return f"候选模型平衡准确率未改善：{candidate_balanced:.4f}<{baseline_balanced:.4f}"
        if candidate_f1 < baseline_f1:
            return f"候选模型宏 F1 未改善：{candidate_f1:.4f}<{baseline_f1:.4f}"
        return None
    if candidate.get("featureNames") != current.get("featureNames"):
        return "无法在同一未来测试集比较 incumbent；候选模型未晋级，请先解决特征兼容性并完成公平比较"
    return "无法在同一未来测试集比较 incumbent；请等待前向验证数据后晋级"


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
        train_args = [
            "--input", *input_paths, "--interval", args.interval,
            "--horizon-bars", os.getenv("PREDICTION_HORIZON_BARS", "3"),
            "--output-dir", str(candidate),
        ]
        if (target / "direction.txt").is_file() and (target / "metadata.json").is_file():
            train_args.extend(["--baseline-model-dir", str(target)])
        run_module("prediction.train", train_args)
        metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
        current_metadata_path = target / "metadata.json"
        current = None
        if current_metadata_path.exists():
            current = json.loads(current_metadata_path.read_text(encoding="utf-8"))
        status = candidate_status(metadata, current, args.min_test_samples)
        if status:
            raise SystemExit(status)
        accuracy = metric(metadata, "accuracy", 0.0)
        brier = metric(metadata, "brier", float("inf"))
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
