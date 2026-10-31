"""Helpers for emitting training progress to a worker and the UI."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


def report_progress(phase: str, **fields: Any) -> dict[str, Any]:
    """Atomically merge progress state and emit one machine-readable log line."""
    path_value = os.getenv("PREDICTION_TRAINING_PROGRESS_FILE", "").strip()
    state: dict[str, Any] = {}
    path = Path(path_value) if path_value else None
    if path is not None:
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                state.update(loaded)
        except (OSError, json.JSONDecodeError):
            pass
    state.update(fields)
    state["phase"] = phase
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
    print(f"KEEL_TRAIN_PROGRESS {json.dumps(state, ensure_ascii=False, separators=(',', ':'))}", flush=True)
    return state
