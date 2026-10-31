"""Train a LightGBM direction model and export it as ONNX.

Example:
  python -m prediction.train --input data/BTCUSDT-1h.csv data/ETHUSDT-1h.csv \
    --interval 1h --horizon-bars 3 --output-dir prediction/models/1h

Training dependencies are intentionally imported lazily so data collection
and feature validation still work in a minimal Python installation.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .features import FEATURE_NAMES, Candle, build_training_rows, drop_open_candle, normalize_candles
from .training_progress import report_progress


def read_csv(path: Path) -> list[Candle]:
    with path.open("r", newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return normalize_candles(rows)


def brier_score(probabilities: list[list[float]], labels: list[int]) -> float:
    if not labels:
        return 0.0
    return sum(sum((probability[index] - float(index == label)) ** 2 for index in range(3)) for probability, label in zip(probabilities, labels)) / len(labels)


def log_loss(probabilities: list[list[float]], labels: list[int]) -> float:
    if not labels:
        return 0.0
    return -sum(math.log(max(min(probability[label], 1.0 - 1e-12), 1e-12)) for probability, label in zip(probabilities, labels)) / len(labels)


def calibrate_temperature(probabilities: list[list[float]], labels: list[int]) -> float:
    """Fit a small temperature scaler on the time-ordered validation fold.

    This keeps calibration deterministic and dependency-free. The scaler is
    applied to the model probabilities at inference time, never to labels or
    the future test fold.
    """
    if not labels:
        return 1.0
    best_temperature = 1.0
    best_loss = log_loss(probabilities, labels)
    for step in range(1, 51):
        temperature = 0.5 + step * 0.05
        scaled: list[list[float]] = []
        for row in probabilities:
            logits = [math.log(max(min(value, 1.0 - 1e-12), 1e-12)) / temperature for value in row]
            maximum = max(logits)
            exp_values = [math.exp(value - maximum) for value in logits]
            total = sum(exp_values)
            scaled.append([value / total for value in exp_values])
        loss = log_loss(scaled, labels)
        if loss < best_loss:
            best_loss = loss
            best_temperature = temperature
    return best_temperature


def apply_temperature(probabilities: list[list[float]], temperature: float) -> list[list[float]]:
    if temperature == 1.0:
        return probabilities
    result: list[list[float]] = []
    for row in probabilities:
        logits = [math.log(max(min(value, 1.0 - 1e-12), 1e-12)) / temperature for value in row]
        maximum = max(logits)
        exp_values = [math.exp(value - maximum) for value in logits]
        total = sum(exp_values)
        result.append([value / total for value in exp_values])
    return result


def classification_metrics(probabilities: list[list[float]], labels: list[int]) -> dict[str, float]:
    if not labels:
        return {"accuracy": 0.0, "balancedAccuracy": 0.0, "macroF1": 0.0, "confidenceCoverage": 0.0, "selectiveAccuracy": 0.0}
    predictions = [max(range(3), key=probability.__getitem__) for probability in probabilities]
    accuracy = sum(prediction == label for prediction, label in zip(predictions, labels)) / len(labels)
    recalls: list[float] = []
    f1_values: list[float] = []
    for label in range(3):
        true_positive = sum(prediction == label and actual == label for prediction, actual in zip(predictions, labels))
        false_positive = sum(prediction == label and actual != label for prediction, actual in zip(predictions, labels))
        false_negative = sum(prediction != label and actual == label for prediction, actual in zip(predictions, labels))
        recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
        precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
        recalls.append(recall)
        f1_values.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    confident = [index for index, probability in enumerate(probabilities) if max(probability) >= 0.55]
    selective = sum(predictions[index] == labels[index] for index in confident) / len(confident) if confident else 0.0
    present_labels = [label for label in range(3) if any(actual == label for actual in labels)]
    return {
        "accuracy": accuracy,
        "balancedAccuracy": sum(recalls[label] for label in present_labels) / len(present_labels),
        "macroF1": sum(f1_values) / 3,
        "confidenceCoverage": len(confident) / len(labels),
        "selectiveAccuracy": selective,
    }


def purged_time_splits(row_times: list[float], label_end_times: list[float], validation_ratio: float, test_ratio: float) -> tuple[list[int], list[int], list[int], float, float]:
    """Create chronological train/validation/test folds and purge horizon overlap.

    Every sample carries the timestamp of the candle used to create its label.
    Train labels must end before validation starts, and validation labels must
    end before the untouched test fold starts.
    """
    if len(row_times) != len(label_end_times) or len(row_times) < 3:
        raise ValueError("row_times and label_end_times must have the same length >= 3")
    if not 0 < validation_ratio < 0.5 or not 0 < test_ratio < 0.5 or validation_ratio + test_ratio >= 0.8:
        raise ValueError("validation_ratio and test_ratio are invalid")
    total = len(row_times)
    raw_validation_start = max(1, int(total * (1 - test_ratio - validation_ratio)))
    raw_test_start = max(raw_validation_start + 1, int(total * (1 - test_ratio)))
    if raw_test_start >= total:
        raise ValueError("not enough rows for chronological folds")
    validation_start_time = row_times[raw_validation_start]
    test_start_time = row_times[raw_test_start]
    train = [index for index, row_time in enumerate(row_times) if row_time < validation_start_time and label_end_times[index] < validation_start_time]
    validation = [index for index, row_time in enumerate(row_times) if validation_start_time <= row_time < test_start_time and label_end_times[index] < test_start_time]
    test = [index for index, row_time in enumerate(row_times) if row_time >= test_start_time]
    if not train or not validation or not test:
        raise ValueError("purging left an empty chronological fold")
    return train, validation, test, validation_start_time, test_start_time


def feature_indices_for_model(current_features: list[str], model_features: Any) -> list[int] | None:
    """Map a supported incumbent feature schema onto the current feature rows."""
    if not isinstance(model_features, list) or not model_features:
        return None
    if any(not isinstance(name, str) for name in model_features) or len(set(model_features)) != len(model_features):
        return None
    current_indices = {name: index for index, name in enumerate(current_features)}
    if any(name not in current_indices for name in model_features):
        return None
    return [current_indices[name] for name in model_features]


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a local LightGBM direction model")
    parser.add_argument("--input", required=True, type=Path, nargs="+", help="一个或多个 CSV；每个文件包含 time,open,high,low,close,volume")
    parser.add_argument("--symbol", help="交易对；多个 CSV 默认训练通用模型（*），单个 CSV 未提供时从文件名推断")
    parser.add_argument("--interval", choices=["15m", "1h", "4h", "1d"], required=True)
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--baseline-model-dir", type=Path, help="可选：在同一时间留出集上评估 incumbent LightGBM 模型")
    parser.add_argument("--neutral-threshold", type=float, default=0.0015, help="最小中性收益阈值，例如 0.0015=0.15%%")
    parser.add_argument("--test-ratio", type=float, default=0.15)
    parser.add_argument("--validation-ratio", type=float, default=0.15)
    args = parser.parse_args()
    if not 0 < args.test_ratio < 0.5 or not 0 < args.validation_ratio < 0.5 or args.test_ratio + args.validation_ratio >= 0.8:
        parser.error("test-ratio 和 validation-ratio 必须合理且总和小于 0.8")
    input_paths: list[Path] = []
    for path in args.input:
        if path.is_dir():
            input_paths.extend(sorted(path.glob(f"*-{args.interval}.csv")))
        else:
            input_paths.append(path)
    if not input_paths:
        parser.error("没有找到可训练的 CSV 文件")
    inferred_symbols = [path.stem.split("-")[0].upper() for path in input_paths]
    if len(input_paths) > 1 and args.symbol and args.symbol.upper() not in {"*", "ALL"}:
        parser.error("多个输入文件必须训练通用模型，请省略 --symbol 或使用 --symbol *")
    symbol = (args.symbol or (inferred_symbols[0] if len(input_paths) == 1 else "*")).upper()
    if symbol not in {"*", "ALL"} and (not symbol.isalnum() or not 3 <= len(symbol) <= 20):
        parser.error("symbol 必须是 3 到 20 位字母或数字")
    if symbol == "ALL":
        symbol = "*"
    training_rows: list[tuple[float, float, list[float], int, float]] = []
    source_candles: list[Candle] = []
    for input_path in input_paths:
        candles = drop_open_candle(read_csv(input_path), args.interval)
        features_for_symbol, labels_for_symbol, returns_for_symbol = build_training_rows(candles, args.horizon_bars, args.neutral_threshold)
        source_candles.extend(candles)
        row_times = [candles[index].time for index in range(49, len(candles) - args.horizon_bars)]
        label_end_times = [candles[index + args.horizon_bars].time for index in range(49, len(candles) - args.horizon_bars)]
        training_rows.extend(zip(row_times, label_end_times, features_for_symbol, labels_for_symbol, returns_for_symbol))
    # Keep the chronological split meaningful when several symbols are mixed.
    training_rows.sort(key=lambda row: row[0])
    row_times = [row[0] for row in training_rows]
    label_end_times = [row[1] for row in training_rows]
    features = [row[2] for row in training_rows]
    labels = [row[3] for row in training_rows]
    returns = [row[4] for row in training_rows]
    if len(features) < 120:
        parser.error(f"有效训练样本只有 {len(features)} 条，至少需要 120 条")
    report_progress("training", interval=args.interval, symbolIndex=len(input_paths), symbolCount=len(input_paths), rowsFetched=len(features), message=f"已准备 {len(features)} 条训练样本，开始拟合模型")
    try:
        import numpy as np
        import lightgbm as lgb
    except ImportError as error:
        raise SystemExit("缺少训练依赖，请先运行 python -m pip install -r prediction/requirements.txt") from error
    try:
        train_indices, validation_indices, test_indices, validation_start_time, test_start_time = purged_time_splits(
            row_times, label_end_times, args.validation_ratio, args.test_ratio,
        )
    except ValueError as error:
        parser.error(str(error))
    x_train = np.asarray([features[index] for index in train_indices], dtype=np.float32)
    y_train = np.asarray([labels[index] for index in train_indices], dtype=np.int32)
    x_validation = np.asarray([features[index] for index in validation_indices], dtype=np.float32)
    y_validation = np.asarray([labels[index] for index in validation_indices], dtype=np.int32)
    x_test = np.asarray([features[index] for index in test_indices], dtype=np.float32)
    y_test = np.asarray([labels[index] for index in test_indices], dtype=np.int32)
    if len(set(y_train.tolist())) < 3:
        parser.error("训练集没有包含三个方向类别，请扩大数据范围或调整 neutral-threshold")
    model = lgb.LGBMClassifier(
        objective="multiclass",
        num_class=3,
        n_estimators=350,
        learning_rate=0.035,
        num_leaves=31,
        max_depth=-1,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=-1,
        verbosity=-1,
    )
    callbacks = [lgb.early_stopping(35, verbose=False)]
    class_counts = np.bincount(y_train, minlength=3).astype(np.float64)
    class_weights = np.where(class_counts > 0, len(y_train) / (3.0 * class_counts), 0.0)
    sample_weight = class_weights[y_train]
    model.fit(x_train, y_train, sample_weight=sample_weight, eval_set=[(x_validation, y_validation)], callbacks=callbacks)
    validation_probabilities = model.predict_proba(x_validation).tolist()
    temperature = calibrate_temperature(validation_probabilities, y_validation.tolist())
    probabilities = apply_temperature(model.predict_proba(x_test).tolist(), temperature)
    metrics = classification_metrics(probabilities, y_test.tolist())
    brier = brier_score(probabilities, y_test.tolist()) if len(y_test) else 0.0
    report_progress("validating", interval=args.interval, symbolIndex=len(input_paths), symbolCount=len(input_paths), rowsFetched=len(features), message="测试集评估与 incumbent 对比准备完成")
    baseline_comparison: dict[str, Any] = {"compatible": False, "reason": "没有提供 incumbent 模型"}
    if args.baseline_model_dir:
        baseline_metadata_path = args.baseline_model_dir / "metadata.json"
        baseline_native_path = args.baseline_model_dir / "direction.txt"
        if baseline_metadata_path.exists() and baseline_native_path.exists():
            incumbent_metadata = json.loads(baseline_metadata_path.read_text(encoding="utf-8"))
            incumbent_features = incumbent_metadata.get("featureNames")
            incumbent_indices = feature_indices_for_model(list(FEATURE_NAMES), incumbent_features)
            if incumbent_indices:
                incumbent = lgb.Booster(model_file=str(baseline_native_path))
                if incumbent.num_feature() != len(incumbent_indices):
                    baseline_comparison = {"compatible": False, "reason": "incumbent 特征数量与模型文件不一致"}
                else:
                    baseline_probabilities = incumbent.predict(x_test[:, incumbent_indices]).tolist()
                    baseline_temperature = float(incumbent_metadata.get("probabilityTemperature", 1.0))
                    baseline_probabilities = apply_temperature(baseline_probabilities, baseline_temperature)
                    baseline_metrics = classification_metrics(baseline_probabilities, y_test.tolist())
                    baseline_metrics["brier"] = brier_score(baseline_probabilities, y_test.tolist()) if len(y_test) else 0.0
                    baseline_metrics["testSamples"] = len(y_test)
                    baseline_comparison = {"compatible": True, "metrics": baseline_metrics, "version": incumbent_metadata.get("version", "unknown")}
            else:
                baseline_comparison = {"compatible": False, "reason": "incumbent 特征 schema 与本地特征不兼容"}
        else:
            baseline_comparison = {"compatible": False, "reason": "incumbent native model or metadata is missing"}
    report_progress("exporting", interval=args.interval, symbolIndex=len(input_paths), symbolCount=len(input_paths), rowsFetched=len(features), message="正在导出 LightGBM 和 ONNX 模型")
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    native_path = output_dir / "direction.txt"
    model.booster_.save_model(str(native_path))
    try:
        from onnxmltools import convert_lightgbm
        from onnxmltools.convert.common.data_types import FloatTensorType
        onnx_model = convert_lightgbm(
            model,
            initial_types=[("features", FloatTensorType([None, len(FEATURE_NAMES)]))],
            zipmap=False,
        )
        (output_dir / "direction.onnx").write_bytes(onnx_model.SerializeToString())
    except ImportError as error:
        raise SystemExit("LightGBM 已训练但缺少 ONNX 导出依赖，请安装 prediction/requirements.txt 后重试") from error
    metadata = {
        "model": "lightgbm-direction",
        "symbol": symbol,
        "version": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "interval": args.interval,
        "horizonBars": args.horizon_bars,
        "featureNames": list(FEATURE_NAMES),
        "classes": ["DOWN", "NEUTRAL", "UP"],
        "minHistory": 50,
        "metrics": {"testSamples": len(y_test), "brier": brier, **metrics},
        "probabilityTemperature": temperature,
        "baselineComparison": baseline_comparison,
        "neutralThreshold": args.neutral_threshold,
        "temporalSplits": {
            "trainSamples": len(y_train),
            "validationSamples": len(y_validation),
            "testSamples": len(y_test),
            "validationStart": validation_start_time,
            "testStart": test_start_time,
            "purgedOverlap": True,
        },
        "trainedThrough": max(candle.time for candle in source_candles),
        "source": [str(path) for path in input_paths],
        "trainingSymbols": sorted(set(inferred_symbols)),
        "expectedReturnModel": None,
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

