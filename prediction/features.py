"""Feature extraction shared by training and local inference.

The module intentionally uses only the Python standard library so feature
generation can be inspected and tested without installing the model runtime.
The caller must pass candles in ascending time order.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Any, Iterable, Sequence


FEATURE_NAMES = (
    "return_1",
    "return_3",
    "return_5",
    "return_10",
    "return_20",
    "range_pct",
    "body_pct",
    "upper_wick_pct",
    "lower_wick_pct",
    "ema20_gap_pct",
    "ema50_gap_pct",
    "rsi14",
    "atr14_pct",
    "volume_ratio20",
    "volume_return_5",
    "trend_efficiency20",
)


@dataclass(frozen=True)
class Candle:
    time: float
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


def _number(value: Any, name: str) -> float:
    number = float(value)
    if not isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def normalize_candles(rows: Iterable[Any]) -> list[Candle]:
    result: list[Candle] = []
    for index, row in enumerate(rows):
        if isinstance(row, dict):
            get = row.get
        elif isinstance(row, (list, tuple)) and len(row) >= 6:
            get = lambda key, default=None, row=row: row[{"time": 0, "open": 1, "high": 2, "low": 3, "close": 4, "volume": 5}[key]] if key != "volume" or len(row) > 5 else default
        else:
            raise ValueError(f"candle {index} must be an object or Binance array")
        candle = Candle(
            time=_number(get("time"), f"candle {index}.time"),
            open=_number(get("open"), f"candle {index}.open"),
            high=_number(get("high"), f"candle {index}.high"),
            low=_number(get("low"), f"candle {index}.low"),
            close=_number(get("close"), f"candle {index}.close"),
            volume=_number(get("volume", 0.0) or 0.0, f"candle {index}.volume"),
        )
        if min(candle.open, candle.high, candle.low, candle.close) <= 0 or candle.volume < 0:
            raise ValueError(f"candle {index} contains a non-positive price or negative volume")
        if candle.high < max(candle.open, candle.close, candle.low) or candle.low > min(candle.open, candle.close, candle.high):
            raise ValueError(f"candle {index} has invalid high/low bounds")
        result.append(candle)
    if any(left.time >= right.time for left, right in zip(result, result[1:])):
        raise ValueError("candles must be strictly ascending by time")
    return result


def drop_open_candle(candles: Sequence[Candle], interval: str, now_ms: int | None = None) -> list[Candle]:
    """Remove a currently forming candle when its timestamp proves it is open."""
    interval_ms = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}.get(interval)
    if not interval_ms or not candles:
        return list(candles)
    import time

    now = now_ms if now_ms is not None else int(time.time() * 1000)
    last = candles[-1]
    timestamp_ms = last.time * 1000 if last.time < 10_000_000_000 else last.time
    return list(candles[:-1]) if timestamp_ms + interval_ms > now else list(candles)


def _ema(values: Sequence[float], period: int) -> float:
    if not values:
        return 0.0
    alpha = 2.0 / (period + 1)
    current = values[0]
    for value in values[1:]:
        current += alpha * (value - current)
    return current


def _rsi(values: Sequence[float], period: int = 14) -> float:
    if len(values) <= period:
        return 50.0
    gains = sum(max(values[index] - values[index - 1], 0.0) for index in range(1, period + 1)) / period
    losses = sum(max(values[index - 1] - values[index], 0.0) for index in range(1, period + 1)) / period
    for index in range(period + 1, len(values)):
        change = values[index] - values[index - 1]
        gains = (gains * (period - 1) + max(change, 0.0)) / period
        losses = (losses * (period - 1) + max(-change, 0.0)) / period
    if gains == 0 and losses == 0:
        return 50.0
    if losses == 0:
        return 100.0
    if gains == 0:
        return 0.0
    return 100.0 - 100.0 / (1.0 + gains / losses)


def _atr(candles: Sequence[Candle], period: int = 14) -> float:
    if not candles:
        return 0.0
    ranges: list[float] = []
    start = max(0, len(candles) - period)
    for index in range(start, len(candles)):
        candle = candles[index]
        previous = candles[index - 1].close if index else candle.close
        ranges.append(max(candle.high - candle.low, abs(candle.high - previous), abs(candle.low - previous)))
    return sum(ranges) / len(ranges)


def feature_row(candles: Sequence[Candle]) -> list[float]:
    """Return one finite feature vector for the latest candle."""
    if len(candles) < 50:
        raise ValueError("at least 50 closed candles are required")
    closes = [candle.close for candle in candles]
    latest = candles[-1]
    close = latest.close
    previous_close = closes[-2]
    safe_close = max(close, 1e-12)
    returns = [closes[-1] / closes[-1 - period] - 1.0 for period in (1, 3, 5, 10, 20)]
    candle_range = max(latest.high - latest.low, 0.0)
    body = abs(latest.close - latest.open)
    upper_wick = max(latest.high - max(latest.open, latest.close), 0.0)
    lower_wick = max(min(latest.open, latest.close) - latest.low, 0.0)
    ema20 = _ema(closes[-200:], 20)
    ema50 = _ema(closes[-400:], 50)
    atr = _atr(candles, 14)
    volumes = [candle.volume for candle in candles[-21:]]
    average_volume = sum(volumes[-20:]) / min(20, len(volumes))
    movement = sum(abs(closes[index] - closes[index - 1]) for index in range(max(1, len(closes) - 20), len(closes)))
    net_movement = abs(closes[-1] - closes[max(0, len(closes) - 21)])
    values = [
        *returns,
        candle_range / safe_close,
        body / safe_close,
        upper_wick / safe_close,
        lower_wick / safe_close,
        (close - ema20) / safe_close,
        (close - ema50) / safe_close,
        _rsi(closes[-200:]),
        atr / safe_close,
        latest.volume / average_volume if average_volume > 0 else 1.0,
        volumes[-1] / max(volumes[-6], 1e-12) - 1.0,
        net_movement / movement if movement > 0 else 0.0,
    ]
    if len(values) != len(FEATURE_NAMES) or not all(isfinite(value) for value in values):
        raise ValueError("feature extraction produced a non-finite value")
    return values


def build_training_rows(candles: Sequence[Candle], horizon_bars: int, neutral_threshold: float = 0.0015) -> tuple[list[list[float]], list[int], list[float]]:
    """Build time-ordered feature rows and 0=DOWN/1=NEUTRAL/2=UP labels."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    if len(candles) < 50 + horizon_bars:
        raise ValueError("not enough candles for training")
    features: list[list[float]] = []
    labels: list[int] = []
    returns: list[float] = []
    for index in range(49, len(candles) - horizon_bars):
        window = candles[: index + 1]
        row = feature_row(window)
        future_return = candles[index + horizon_bars].close / candles[index].close - 1.0
        threshold = max(neutral_threshold, _atr(window, 14) / candles[index].close * 0.25)
        label = 2 if future_return > threshold else 0 if future_return < -threshold else 1
        features.append(row)
        labels.append(label)
        returns.append(future_return)
    return features, labels, returns

