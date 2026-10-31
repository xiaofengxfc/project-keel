"""Local ONNX inference service for the KEEL prediction endpoint."""

from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .features import Candle, drop_open_candle, feature_row, normalize_candles


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

    def load(self) -> None:
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
        self.bundles: dict[str, ModelBundle] = {}
        self.load_error = "模型尚未加载"
        self.load()

    def load(self) -> None:
        candidates: list[tuple[str, Path]] = [
            (interval, self.model_root / interval)
            for interval in ("15m", "1h", "4h", "1d")
        ]
        candidates.extend([("current", self.model_root / "current"), ("*", self.model_root)])
        for key, model_dir in candidates:
            if key in self.bundles or not model_dir.is_dir():
                continue
            bundle = ModelBundle(model_dir)
            if bundle.ready:
                self.bundles[key] = bundle
        if self.bundles:
            self.load_error = ""
        else:
            self.load_error = f"未找到可用模型：请在 {self.model_root} 下生成 direction.onnx 和 metadata.json"

    @property
    def ready(self) -> bool:
        return bool(self.bundles)

    def bundle_for(self, interval: str, symbol: str) -> ModelBundle | None:
        # Prefer an interval-specific model. A legacy `current` model is only
        # eligible when its metadata explicitly matches this request, so a
        # stale single-symbol/1h model can never be applied to another coin or
        # timeframe by accident.
        for key in (interval, "*", "current"):
            bundle = self.bundles.get(key)
            if bundle is None:
                continue
            expected_interval = bundle.metadata.get("interval")
            if expected_interval not in (None, "*", interval):
                continue
            expected_symbol = str(bundle.metadata.get("symbol", "*")).upper()
            if expected_symbol not in {"*", "ALL", symbol}:
                continue
            return bundle
        return None


app = FastAPI(title="KEEL local prediction service", version="1.0")
state = ModelState()


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "ready": state.ready, "models": sorted(state.bundles), "error": state.load_error or None}


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
        if expected_interval not in (None, "*", request.interval):
            raise HTTPException(status_code=422, detail=f"当前模型仅支持 {expected_interval} 周期")
        expected_symbol = bundle.metadata.get("symbol")
        if expected_symbol and str(expected_symbol).upper() not in {"*", "ALL", symbol}:
            raise HTTPException(status_code=422, detail=f"当前模型仅支持 {str(expected_symbol).upper()}，请为 {symbol} 训练对应模型")
        expected_horizon = int(bundle.metadata.get("horizonBars", request.horizonBars or 3))
        if request.horizonBars is not None and request.horizonBars != expected_horizon:
            raise HTTPException(status_code=422, detail=f"当前模型预测周期为 {expected_horizon} 根 K 线")
        probabilities = bundle.predict(feature_row(closed))
        if any(not 0 <= probability <= 1 or not math.isfinite(probability) for probability in probabilities):
            raise RuntimeError("模型返回了无效概率")
        total = sum(probabilities)
        if total <= 0:
            raise RuntimeError("模型返回概率总和无效")
        probabilities = [probability / total for probability in probabilities]
        direction_index = max(range(3), key=probabilities.__getitem__)
        labels = ["DOWN", "NEUTRAL", "UP"]
        direction = labels[direction_index]
        confidence = probabilities[direction_index]
        return {
            "model": bundle.metadata.get("model", "lightgbm-direction"),
            "version": bundle.metadata.get("version", "unknown"),
            # Use Unix seconds to keep the contract language-neutral and make
            # stale-result checks cheap in both Node and Python clients.
            "generatedAt": int(time.time()),
            # Candle timestamps may be supplied in seconds or milliseconds;
            # keep the public contract in Unix seconds for the web client.
            "dataThrough": int(closed[-1].time / 1000) if closed[-1].time >= 10_000_000_000 else int(closed[-1].time),
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

