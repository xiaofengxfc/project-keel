"""Local ONNX inference service for the KEEL prediction endpoint."""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from .features import FEATURE_NAMES, Candle, drop_open_candle, feature_row, normalize_candles


INTERVAL_SECONDS = {"15m": 900, "1h": 3_600, "4h": 14_400, "1d": 86_400}
LABELS = ("DOWN", "NEUTRAL", "UP")


def unix_seconds(value: float) -> int:
    return int(value / 1000) if value >= 10_000_000_000 else int(value)


def outcome_neutral_threshold(candles: list[Candle], minimum: float = 0.0015) -> float:
    """Mirror the trainer's ATR-based neutral label threshold at forecast time."""
    if not candles:
        return minimum
    start = max(0, len(candles) - 14)
    true_ranges: list[float] = []
    for index in range(start, len(candles)):
        candle = candles[index]
        previous = candles[index - 1].close if index else candle.close
        true_ranges.append(max(candle.high - candle.low, abs(candle.high - previous), abs(candle.low - previous)))
    atr = sum(true_ranges) / len(true_ranges)
    return max(minimum, atr / candles[-1].close * 0.25)


def features_for_bundle(candles: list[Candle], metadata: dict[str, Any]) -> list[float]:
    values = feature_row(candles)
    requested_names = metadata.get("featureNames")
    if not isinstance(requested_names, list) or not requested_names:
        return values
    if len(requested_names) == len(FEATURE_NAMES) and requested_names == list(FEATURE_NAMES):
        return values
    by_name = dict(zip(FEATURE_NAMES, values))
    if any(not isinstance(name, str) or name not in by_name for name in requested_names):
        raise RuntimeError("模型特征与本地特征版本不兼容")
    return [by_name[name] for name in requested_names]


class ForwardValidationStore:
    """Local-only store for prediction outcomes; raw candles are never persisted."""

    def __init__(self, path: Path | None = None) -> None:
        configured_db = os.getenv("PREDICTION_VALIDATION_DB", "").strip()
        if path is not None:
            self.path = path
        elif configured_db:
            self.path = Path(configured_db)
        else:
            directory = Path(os.getenv("PREDICTION_VALIDATION_DIR", "prediction/validation"))
            self.path = directory / "predictions.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            try:
                self.path.parent.chmod(0o700)
            except OSError:
                pass
        self.retention_days = max(1, int(os.getenv("PREDICTION_VALIDATION_RETENTION_DAYS", "90")))
        self._initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """CREATE TABLE IF NOT EXISTS predictions (
                    id INTEGER PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    horizon_bars INTEGER NOT NULL,
                    data_through INTEGER NOT NULL,
                    origin_close REAL NOT NULL,
                    probability_down REAL NOT NULL,
                    probability_neutral REAL NOT NULL,
                    probability_up REAL NOT NULL,
                    predicted_label INTEGER NOT NULL,
                    neutral_threshold REAL NOT NULL DEFAULT 0.0015,
                    model_version TEXT NOT NULL,
                    generated_at INTEGER NOT NULL,
                    actual_label INTEGER,
                    actual_return REAL,
                    settled_at INTEGER,
                    UNIQUE(symbol, interval, horizon_bars, data_through, model_version)
                )"""
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(predictions)").fetchall()}
            if "neutral_threshold" not in columns:
                connection.execute("ALTER TABLE predictions ADD COLUMN neutral_threshold REAL NOT NULL DEFAULT 0.0015")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_predictions_filter ON predictions(symbol, interval, horizon_bars, data_through)")
        if os.name != "nt":
            try:
                self.path.chmod(0o600)
            except OSError:
                pass

    def purge_expired(self, now: int | None = None) -> None:
        """Remove old forward-validation rows, including forecasts that never settled."""
        cutoff = (int(time.time()) if now is None else now) - self.retention_days * 86_400
        with self._connect() as connection:
            connection.execute("DELETE FROM predictions WHERE generated_at < ?", (cutoff,))

    def settle(self, symbol: str, interval: str, candles: list[Candle]) -> None:
        self.purge_expired()
        if not candles:
            return
        latest_by_time = {unix_seconds(candle.time): candle for candle in candles}
        latest_time = max(latest_by_time)
        interval_seconds = INTERVAL_SECONDS[interval]
        with self._connect() as connection:
            pending = connection.execute(
                "SELECT id, data_through, origin_close, horizon_bars, neutral_threshold FROM predictions WHERE symbol = ? AND interval = ? AND actual_label IS NULL",
                (symbol, interval),
            ).fetchall()
            for row in pending:
                target_time = int(row["data_through"]) + interval_seconds * int(row["horizon_bars"])
                if target_time > latest_time:
                    continue
                target = latest_by_time.get(target_time)
                if target is None:
                    continue
                actual_return = target.close / float(row["origin_close"]) - 1.0
                threshold = float(row["neutral_threshold"])
                actual_label = 2 if actual_return > threshold else 0 if actual_return < -threshold else 1
                connection.execute(
                    "UPDATE predictions SET actual_label = ?, actual_return = ?, settled_at = ? WHERE id = ?",
                    (actual_label, actual_return, int(time.time()), int(row["id"])),
                )

    def record(self, *, symbol: str, interval: str, horizon_bars: int, data_through: int, origin_close: float, probabilities: list[float], predicted_label: int, neutral_threshold: float, model_version: str, generated_at: int) -> None:
        with self._connect() as connection:
            connection.execute(
                """INSERT OR IGNORE INTO predictions
                (symbol, interval, horizon_bars, data_through, origin_close, probability_down, probability_neutral, probability_up, predicted_label, neutral_threshold, model_version, generated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (symbol, interval, horizon_bars, data_through, origin_close, probabilities[0], probabilities[1], probabilities[2], predicted_label, neutral_threshold, model_version, generated_at),
            )

    def metrics(self, symbol: str | None = None, interval: str | None = None, horizon_bars: int | None = None) -> dict[str, Any]:
        # Metrics may be viewed while no new prediction is arriving. Expire old
        # unsettled rows here too so they cannot linger in the pending count.
        self.purge_expired()
        clauses: list[str] = []
        values: list[Any] = []
        if symbol:
            clauses.append("symbol = ?")
            values.append(symbol)
        if interval:
            clauses.append("interval = ?")
            values.append(interval)
        if horizon_bars is not None:
            clauses.append("horizon_bars = ?")
            values.append(horizon_bars)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT model_version, predicted_label, actual_label, probability_down, probability_neutral, probability_up, actual_return FROM predictions{where}",
                values,
            ).fetchall()
        grouped: dict[str, list[sqlite3.Row]] = {}
        for row in rows:
            grouped.setdefault(str(row["model_version"]), []).append(row)
        result = summarize_validation_rows(rows)
        result["byModelVersion"] = {version: summarize_validation_rows(version_rows) for version, version_rows in sorted(grouped.items())}
        return result


def summarize_validation_rows(rows: list[sqlite3.Row]) -> dict[str, Any]:
    """Summarize one model's forward outcomes, keeping pending forecasts visible."""
    total = len(rows)
    settled_rows = [row for row in rows if row["actual_label"] is not None]
    settled = len(settled_rows)
    if not settled:
        return {"predictions": total, "settled": 0, "pending": total, "accuracy": None, "balancedAccuracy": None, "brier": None, "averageReturnPct": None}
    confusion = [[0 for _ in range(3)] for _ in range(3)]
    brier_total = 0.0
    returns = []
    for row in settled_rows:
        predicted = int(row["predicted_label"])
        actual = int(row["actual_label"])
        confusion[actual][predicted] += 1
        probabilities = [float(row["probability_down"]), float(row["probability_neutral"]), float(row["probability_up"])]
        brier_total += sum((probabilities[index] - float(index == actual)) ** 2 for index in range(3))
        returns.append(float(row["actual_return"]))
    present_labels = [label for label in range(3) if sum(confusion[label])]
    recalls = [confusion[label][label] / sum(confusion[label]) if sum(confusion[label]) else 0.0 for label in range(3)]
    return {
        "predictions": total,
        "settled": settled,
        "pending": total - settled,
        "accuracy": sum(confusion[index][index] for index in range(3)) / settled,
        "balancedAccuracy": sum(recalls[index] for index in present_labels) / len(present_labels),
        "brier": brier_total / settled,
        "averageReturnPct": sum(returns) / len(returns) * 100,
        "byClass": {LABELS[index]: {"actual": sum(confusion[index]), "recall": recalls[index]} for index in range(3)},
    }


class CandleInput(BaseModel):
    time: float
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class PredictionRequest(BaseModel):
    symbol: str = Field(min_length=3, max_length=20)
    interval: str
    candles: list[CandleInput] = Field(min_length=1)
    horizonBars: int | None = Field(default=None, ge=1, le=100)


class ModelBundle:
    def __init__(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        self.session: Any = None
        self.metadata: dict[str, Any] = {}
        self.load_error = "模型尚未加载"
        self.load()

    def load(self) -> str | None:
        metadata_path = self.model_dir / "metadata.json"
        onnx_path = self.model_dir / "direction.onnx"
        if not metadata_path.exists() or not onnx_path.exists():
            self.load_error = f"未找到模型文件：需要 {onnx_path} 和 {metadata_path}"
            return
        try:
            self.metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            import onnxruntime as ort
            self.session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            self.load_error = ""
        except Exception as error:  # runtime errors should be surfaced by /health and /predict
            self.session = None
            self.load_error = f"加载 ONNX 模型失败：{error}"

    @property
    def ready(self) -> bool:
        return self.session is not None and not self.load_error

    def predict(self, values: list[float]) -> list[float]:
        if not self.ready:
            raise RuntimeError(self.load_error)
        import numpy as np
        input_name = self.session.get_inputs()[0].name
        outputs = self.session.run(None, {input_name: np.asarray([values], dtype=np.float32)})
        for output in outputs:
            array = np.asarray(output)
            if array.ndim == 2 and array.shape[0] == 1 and array.shape[1] >= 3:
                return [float(value) for value in array[0][:3]]
            if array.ndim == 1 and array.shape[0] >= 3:
                return [float(value) for value in array[:3]]
            if isinstance(output, (list, tuple)) and output and isinstance(output[0], dict):
                item = output[0]
                values_by_class = [item.get(index, item.get(str(index))) for index in range(3)]
                if all(value is not None for value in values_by_class):
                    return [float(value) for value in values_by_class]
        raise RuntimeError("ONNX 模型没有返回三个方向概率")


class ModelState:
    def __init__(self) -> None:
        self.model_root = Path(os.getenv("PREDICTION_MODEL_DIR", "prediction/models"))
        self.bundles: dict[tuple[str, str], ModelBundle] = {}
        self.load_error = "模型尚未加载"
        self.load()

    def load(self) -> str | None:
        loaded_bundles: dict[tuple[str, str], ModelBundle] = {}
        for interval in ("15m", "1h", "4h", "1d"):
            interval_dir = self.model_root / interval
            if not interval_dir.is_dir():
                continue
            for model_dir in interval_dir.iterdir():
                if not model_dir.is_dir() or model_dir.name.startswith(".") or model_dir.name.endswith(".previous"):
                    continue
                symbol = model_dir.name.upper()
                if not re.fullmatch(r"[A-Z0-9]{3,20}", symbol):
                    continue
                bundle = ModelBundle(model_dir)
                if bundle.ready and bundle.metadata.get("interval") == interval and str(bundle.metadata.get("symbol", "")).upper() == symbol:
                    loaded_bundles[(interval, symbol)] = bundle
        # Every reload replaces the complete snapshot. This prevents a model
        # that was deleted or invalidated on disk from remaining available in
        # memory for predictions.
        self.bundles = loaded_bundles
        if loaded_bundles:
            self.load_error = ""
            return None
        error = f"未找到可用单币种模型：请在 {self.model_root}/<周期>/<币种>/ 下生成 direction.onnx 和 metadata.json"
        self.load_error = error
        return error

    @property
    def ready(self) -> bool:
        return bool(self.bundles)

    def bundle_for(self, interval: str, symbol: str) -> ModelBundle | None:
        return self.bundles.get((interval, symbol.upper()))


def apply_probability_temperature(probabilities: list[float], temperature: float) -> list[float]:
    if not math.isfinite(temperature) or temperature <= 0 or abs(temperature - 1.0) < 1e-9:
        return probabilities
    logits = [math.log(max(min(value, 1.0 - 1e-12), 1e-12)) / temperature for value in probabilities]
    maximum = max(logits)
    exp_values = [math.exp(value - maximum) for value in logits]
    total = sum(exp_values)
    return [value / total for value in exp_values]


app = FastAPI(title="KEEL local prediction service", version="1.0")
state = ModelState()
try:
    validation_store: ForwardValidationStore | None = ForwardValidationStore()
    validation_store_error: str | None = None
except Exception as error:  # Prediction remains available if the local metrics DB is not writable.
    validation_store = None
    validation_store_error = str(error)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "ready": state.ready, "models": sorted(f"{interval}/{symbol}" for interval, symbol in state.bundles), "error": state.load_error or None, "forwardValidation": validation_store is not None}


@app.get("/validation/metrics")
def validation_metrics(symbol: str | None = None, interval: str | None = None, horizonBars: int | None = None) -> dict[str, Any]:
    if symbol is not None:
        symbol = symbol.upper()
        if not re.fullmatch(r"[A-Z0-9]{3,20}", symbol):
            raise HTTPException(status_code=400, detail="symbol 格式无效")
    if interval is not None and interval not in INTERVAL_SECONDS:
        raise HTTPException(status_code=400, detail="interval 必须是 15m、1h、4h 或 1d")
    if horizonBars is not None and (not isinstance(horizonBars, int) or horizonBars < 1 or horizonBars > 100):
        raise HTTPException(status_code=400, detail="horizonBars 必须是 1 到 100")
    if validation_store is None:
        raise HTTPException(status_code=503, detail=f"前向验证数据库不可用：{validation_store_error or '未知错误'}")
    return validation_store.metrics(symbol, interval, horizonBars)


@app.post("/reload")
def reload_models(request: Request) -> dict[str, Any]:
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="模型只能由本地服务重新加载")
    error = state.load()
    if error:
        raise HTTPException(status_code=503, detail=error)
    return {"ok": True, "ready": state.ready, "models": sorted(f"{interval}/{symbol}" for interval, symbol in state.bundles)}


@app.post("/predict")
def predict(request: PredictionRequest) -> dict[str, Any]:
    symbol = request.symbol.upper()
    if not re.fullmatch(r"[A-Z0-9]{3,20}", symbol):
        raise HTTPException(status_code=400, detail="symbol 格式无效")
    if request.interval not in {"15m", "1h", "4h", "1d"}:
        raise HTTPException(status_code=400, detail="interval 必须是 15m、1h、4h 或 1d")
    bundle = state.bundle_for(request.interval, symbol)
    if bundle is None:
        raise HTTPException(status_code=503, detail=state.load_error)
    try:
        candles = normalize_candles([item.model_dump() for item in request.candles])
        closed = drop_open_candle(candles, request.interval)
        minimum = int(bundle.metadata.get("minHistory", 50))
        if len(closed) < minimum:
            raise HTTPException(status_code=422, detail=f"至少需要 {minimum} 根已收盘 K 线")
        expected_interval = bundle.metadata.get("interval")
        if expected_interval != request.interval:
            raise HTTPException(status_code=422, detail=f"当前模型仅支持 {expected_interval} 周期")
        expected_symbol = bundle.metadata.get("symbol")
        if not expected_symbol or str(expected_symbol).upper() != symbol:
            raise HTTPException(status_code=422, detail=f"当前模型仅支持 {str(expected_symbol).upper()}，请为 {symbol} 训练对应模型")
        expected_horizon = int(bundle.metadata.get("horizonBars", request.horizonBars or 3))
        if request.horizonBars is not None and request.horizonBars != expected_horizon:
            raise HTTPException(status_code=422, detail=f"当前模型预测周期为 {expected_horizon} 根 K 线")
        probabilities = bundle.predict(features_for_bundle(closed, bundle.metadata))
        if any(not 0 <= probability <= 1 or not math.isfinite(probability) for probability in probabilities):
            raise RuntimeError("模型返回了无效概率")
        total = sum(probabilities)
        if total <= 0:
            raise RuntimeError("模型返回概率总和无效")
        probabilities = [probability / total for probability in probabilities]
        temperature = float(bundle.metadata.get("probabilityTemperature", 1.0))
        probabilities = apply_probability_temperature(probabilities, temperature)
        direction_index = max(range(3), key=probabilities.__getitem__)
        labels = list(LABELS)
        direction = labels[direction_index]
        confidence = probabilities[direction_index]
        generated_at = int(time.time())
        data_through = unix_seconds(closed[-1].time)
        neutral_floor = float(bundle.metadata.get("neutralThreshold", 0.0015))
        if not math.isfinite(neutral_floor) or neutral_floor <= 0:
            neutral_floor = 0.0015
        neutral_threshold = outcome_neutral_threshold(closed, neutral_floor)
        if validation_store is not None:
            try:
                validation_store.settle(symbol, request.interval, closed)
                validation_store.record(
                    symbol=symbol,
                    interval=request.interval,
                    horizon_bars=expected_horizon,
                    data_through=data_through,
                    origin_close=closed[-1].close,
                    probabilities=probabilities,
                    predicted_label=direction_index,
                    neutral_threshold=neutral_threshold,
                    model_version=str(bundle.metadata.get("version", "unknown")),
                    generated_at=generated_at,
                )
            except Exception:
                # Metrics are best-effort and must never make local inference fail.
                pass
        return {
            "model": bundle.metadata.get("model", "lightgbm-direction"),
            "version": bundle.metadata.get("version", "unknown"),
            # Use Unix seconds to keep the contract language-neutral and make
            # stale-result checks cheap in both Node and Python clients.
            "generatedAt": generated_at,
            # Candle timestamps may be supplied in seconds or milliseconds;
            # keep the public contract in Unix seconds for the web client.
            "dataThrough": data_through,
            "interval": request.interval,
            "horizonBars": expected_horizon,
            "direction": direction,
            "probabilityUp": probabilities[2],
            "probabilityDown": probabilities[0],
            "probabilityNeutral": probabilities[1],
            "expectedReturnPct": None,
            "expectedLowPct": None,
            "expectedHighPct": None,
            "confidence": confidence,
            "validation": bundle.metadata.get("metrics", {}),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"预测失败：{error}") from error


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("prediction.service:app", host=os.getenv("PREDICTION_HOST", "127.0.0.1"), port=int(os.getenv("PREDICTION_PORT", "8790")), reload=False)

