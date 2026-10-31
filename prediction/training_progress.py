"""Helpers for emitting training progress to a worker and the UI."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


def _write_progress_file(path: Path, state: dict[str, Any]) -> None:
    """Best-effort atomic snapshot write, tolerating brief Windows file locks."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    open_fd: int | None = fd
    try:
        handle = os.fdopen(fd, "w", encoding="utf-8")
        open_fd = None
        with handle:
            json.dump(state, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())

        for attempt in range(4):
            try:
                os.replace(temporary_name, path)
                temporary_name = ""
                break
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(0.05 * (2**attempt))
    finally:
        if open_fd is not None:
            try:
                os.close(open_fd)
            except OSError:
                pass
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass


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
        try:
            _write_progress_file(path, state)
        except OSError as error:
            try:
                print(f"WARNING: unable to persist training progress: {error}", file=sys.stderr, flush=True)
            except OSError:
                pass
    print(f"KEEL_TRAIN_PROGRESS {json.dumps(state, ensure_ascii=False, separators=(',', ':'))}", flush=True)
    return state
