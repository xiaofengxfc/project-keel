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

from .features import FEATURE_NAMES, Candle, build_training_rows, drop_open_candle, normalize_candles


def read_csv(path: Path) -> list[Candle]:
    with path.open("r", newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return normalize_candles(rows)


def brier_score(probabilities: list[list[float]], labels: list[int]) -> float:
    if not labels:
        return 0.0
    return sum(sum((probability[index] - float(index == label)) ** 2 for index in range(3)) for probability, label in zip(probabilities, labels)) / len(labels)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a local LightGBM direction model")
    parser.add_argument("--input", required=True, type=Path, nargs="+", help="一个或多个 CSV；每个文件包含 time,open,high,low,close,volume")
    parser.add_argument("--symbol", help="交易对；多个 CSV 默认训练通用模型（*），单个 CSV 未提供时从文件名推断")
    parser.add_argument("--interval", choices=["15m", "1h", "4h", "1d"], required=True)
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--output-dir", required=True, type=Path)
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
    training_rows: list[tuple[float, list[float], int, float]] = []
    source_candles: list[Candle] = []
    for input_path in input_paths:
        candles = drop_open_candle(read_csv(input_path), args.interval)
        features_for_symbol, labels_for_symbol, returns_for_symbol = build_training_rows(candles, args.horizon_bars, args.neutral_threshold)
        source_candles.extend(candles)
        row_times = [candles[index].time for index in range(49, len(candles) - args.horizon_bars)]
        training_rows.extend(zip(row_times, features_for_symbol, labels_for_symbol, returns_for_symbol))
    # Keep the chronological split meaningful when several symbols are mixed.
    training_rows.sort(key=lambda row: row[0])
    features = [row[1] for row in training_rows]
    labels = [row[2] for row in training_rows]
    returns = [row[3] for row in training_rows]
    if len(features) < 120:
        parser.error(f"有效训练样本只有 {len(features)} 条，至少需要 120 条")
    try:
        import numpy as np
        import lightgbm as lgb
    except ImportError as error:
        raise SystemExit("缺少训练依赖，请先运行 python -m pip install -r prediction/requirements.txt") from error
    total = len(features)
    test_start = max(1, int(total * (1 - args.test_ratio)))
    validation_start = max(1, int(total * (1 - args.test_ratio - args.validation_ratio)))
    x_train = np.asarray(features[:validation_start], dtype=np.float32)
    y_train = np.asarray(labels[:validation_start], dtype=np.int32)
    x_validation = np.asarray(features[validation_start:test_start], dtype=np.float32)
    y_validation = np.asarray(labels[validation_start:test_start], dtype=np.int32)
    x_test = np.asarray(features[test_start:], dtype=np.float32)
    y_test = np.asarray(labels[test_start:], dtype=np.int32)
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
    model.fit(x_train, y_train, eval_set=[(x_validation, y_validation)], callbacks=callbacks)
    probabilities = model.predict_proba(x_test)
    predictions = probabilities.argmax(axis=1)
    accuracy = float((predictions == y_test).mean()) if len(y_test) else 0.0
    brier = brier_score(probabilities.tolist(), y_test.tolist()) if len(y_test) else 0.0
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
        "metrics": {"testSamples": len(y_test), "accuracy": accuracy, "brier": brier},
        "trainedThrough": max(candle.time for candle in source_candles),
        "source": [str(path) for path in input_paths],
        "trainingSymbols": sorted(set(inferred_symbols)),
        "expectedReturnModel": None,
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

