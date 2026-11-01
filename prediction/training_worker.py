"""Run one or more independent interval training jobs outside the web server."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


LOG_LIMIT = 12_000
PROGRESS_PREFIX = "KEEL_TRAIN_PROGRESS "
SUPPORTED_INTERVALS = {"15m", "1h", "4h", "1d"}
ATOMIC_REPLACE_ATTEMPTS = 4


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())

        # Windows can briefly keep the destination open while the API reads
        # the state file. Retry the atomic replacement instead of aborting the
        # worker on a transient sharing violation.
        for attempt in range(ATOMIC_REPLACE_ATTEMPTS):
            try:
                os.replace(temporary, path)
                temporary = None
                break
            except PermissionError:
                if attempt + 1 >= ATOMIC_REPLACE_ATTEMPTS:
                    raise
                time.sleep(0.05 * (2**attempt))
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def is_not_promoted(return_code: int, output: str) -> bool:
    return return_code == 3 or "NOT_PROMOTED:" in output or any(
        message in output
        for message in ("候选模型未晋级", "候选模型测试样本不足", "无法在同一未来测试集比较")
    )


def short_error(output: str, return_code: int) -> str:
    # Child processes print ANSI-colored tracebacks on Windows terminals. Strip
    # those sequences before storing an error in the UI/state JSON.
    output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
    lines = output.splitlines()
    for line in reversed(lines):
        stripped = line.strip()
        if stripped.startswith("NOT_PROMOTED:"):
            return stripped.removeprefix("NOT_PROMOTED:").strip()

    # subprocess.run(check=True) adds a CalledProcessError after the original
    # traceback. Prefer the underlying exception so the training UI reports
    # the useful cause (for example a file permission or network error).
    exception_lines = [
        line.strip()
        for line in lines
        if re.match(r"^[\w.]+(?:Error|Exception|Interrupt)\s*:", line.strip())
        and not line.strip().startswith("subprocess.CalledProcessError:")
    ]
    if exception_lines:
        return exception_lines[0][-500:]

    for line in reversed(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith((PROGRESS_PREFIX, "Traceback ", "File \"")):
            return stripped[-500:]
    return f"训练脚本退出，代码 {return_code}"


def local_reload_url(configured_url: str) -> str | None:
    try:
        parsed = urllib.parse.urlparse(configured_url)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return None
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/reload", "", "", ""))
    except ValueError:
        return None


def request_reload(configured_url: str) -> str | None:
    reload_url = local_reload_url(configured_url)
    if not reload_url:
        return None
    request = urllib.request.Request(reload_url, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status < 200 or response.status >= 300:
                return "模型已保存，但本地推理服务未能热加载，请重启预测服务。"
    except (OSError, urllib.error.URLError):
        return "模型已保存，但本地推理服务未能热加载，请重启预测服务。"
    return None


def load_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def load_progress(path: Path, job_id: str) -> dict[str, Any]:
    progress = load_state(path)
    if progress.get("jobId") != job_id:
        return {}
    return progress


def append_log(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(message if message.endswith("\n") else f"{message}\n")


def update_job(state_path: Path, state: dict[str, Any], log_path: Path, message: str | None = None) -> None:
    if message:
        append_log(log_path, message)
    state["output"] = ""
    atomic_json(state_path, state)


def update_interval_counters(state: dict[str, Any]) -> None:
    results = state.get("intervalResults", {})
    state["completedIntervals"] = [name for name, item in results.items() if item.get("phase") == "completed"]
    state["finishedIntervals"] = [
        name for name, item in results.items()
        if item.get("phase") in {"completed", "not-promoted", "failed"}
    ]


def final_job_phase(results: dict[str, dict[str, Any]], intervals: list[str]) -> str:
    phases = [results.get(interval, {}).get("phase") for interval in intervals]
    if phases and all(phase == "completed" for phase in phases):
        return "completed"
    if phases and all(phase == "not-promoted" for phase in phases):
        return "not-promoted"
    if phases and all(phase == "failed" for phase in phases):
        return "failed"
    if any(phase in {"completed", "not-promoted"} for phase in phases):
        return "partial"
    return "failed"


def run_interval(
    interval: str,
    symbols: list[str],
    job_id: str,
    state_path: Path,
    progress_path: Path,
    log_path: Path,
    state: dict[str, Any],
) -> dict[str, Any]:
    result: dict[str, Any] = {"phase": "running", "error": None}
    state["currentInterval"] = interval
    state["stage"] = "collecting"
    state["currentSymbol"] = None
    state["symbolIndex"] = 0
    state["pagesFetched"] = 0
    state["rowsFetched"] = 0
    interval_results = state.setdefault("intervalResults", {})
    interval_results[interval] = result
    atomic_json(progress_path, {"jobId": job_id, "phase": "collecting", "interval": interval, "currentSymbol": None, "symbolIndex": 0, "symbolCount": len(symbols), "pagesFetched": 0, "rowsFetched": 0})
    update_job(state_path, state, log_path, f"[{interval}] 开始训练：{', '.join(symbols)}")

    environment = os.environ.copy()
    environment["PREDICTION_TRAINING_PROGRESS_FILE"] = str(progress_path)
    environment["PREDICTION_TRAINING_JOB_ID"] = job_id
    # The progress protocol and log files are UTF-8.  Pin the child Python
    # process to the same encoding so Windows' active code page cannot turn
    # Chinese progress messages into replacement characters.
    environment["PYTHONIOENCODING"] = "utf-8"
    command = [sys.executable, "-u", "-m", "prediction.auto_train", "--symbols", ",".join(symbols), "--interval", interval]
    output_lines: list[str] = []
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, env=environment)
    except OSError as error:
        result.update({"phase": "failed", "error": f"无法启动周期训练脚本：{error}", "finishedAt": int(time.time() * 1000)})
        state["stage"] = "failed"
        state["currentSymbol"] = None
        atomic_json(state_path, state)
        append_log(log_path, f"[{interval}] {result['error']}")
        return result
    state["workerPid"] = os.getpid()
    state["stage"] = "collecting"
    atomic_json(state_path, state)

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip("\r\n")
        if not line:
            continue
        output_lines.append(line)
        if len(output_lines) > 2_000:
            output_lines = output_lines[-1_500:]
        append_log(log_path, line)
        progress: dict[str, Any] = {}
        if line.startswith(PROGRESS_PREFIX):
            try:
                decoded = json.loads(line[len(PROGRESS_PREFIX):])
                if isinstance(decoded, dict):
                    progress = decoded
            except json.JSONDecodeError:
                pass
        if not progress:
            progress = load_progress(progress_path, job_id)
        if progress:
            for field in ("phase", "currentSymbol", "symbolIndex", "symbolCount", "pagesFetched", "rowsFetched", "message"):
                if field in progress:
                    state[field if field != "phase" else "stage"] = progress[field]
            if "interval" in progress:
                state["currentInterval"] = progress["interval"]
            state["output"] = ""
            atomic_json(state_path, state)

    return_code = process.wait()
    output = "\n".join(output_lines)
    if return_code != 0:
        phase = "not-promoted" if is_not_promoted(return_code, output) else "failed"
        error = short_error(output, return_code)
        result.update({"phase": phase, "error": error, "finishedAt": int(time.time() * 1000)})
        state["stage"] = phase
        state["currentSymbol"] = None
        atomic_json(state_path, state)
        append_log(log_path, f"[{interval}] {phase}: {error}")
        return result

    model_root = Path(os.getenv("PREDICTION_MODEL_DIR", "prediction/models"))
    metadata_path = model_root / interval / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("symbol") != "*" or metadata.get("interval") != interval:
            raise RuntimeError("训练产物不是预期的通用周期模型")
        result.update({"phase": "completed", "metrics": metadata.get("metrics", {}), "finishedAt": int(time.time() * 1000)})
        reload_notice = request_reload(os.getenv("PREDICTION_SERVICE_URL", "http://127.0.0.1:8790/predict"))
        if reload_notice:
            result["notice"] = reload_notice
            append_log(log_path, f"[{interval}] {reload_notice}")
    except (OSError, json.JSONDecodeError, RuntimeError) as error:
        result.update({"phase": "failed", "error": str(error), "finishedAt": int(time.time() * 1000)})
    update_interval_counters(state)
    state["stage"] = result["phase"]
    state["currentSymbol"] = None
    update_job(state_path, state, log_path, f"[{interval}] {result['phase']}")
    return result


def record_worker_failure(state_path: Path, log_path: Path, error: BaseException) -> None:
    """Best-effortly persist an unexpected worker exception for the UI."""
    message = f"{type(error).__name__}: {error}"
    try:
        append_log(log_path, f"训练 worker 异常终止：{message}\n{traceback.format_exc().rstrip()}")
    except OSError:
        pass

    state = load_state(state_path)
    if not state:
        return
    current_interval = state.get("currentInterval")
    interval_results = state.get("intervalResults")
    if isinstance(interval_results, dict) and isinstance(current_interval, str):
        current_result = interval_results.get(current_interval)
        if isinstance(current_result, dict) and current_result.get("phase") == "running":
            current_result.update({"phase": "failed", "error": message, "finishedAt": int(time.time() * 1000)})
    update_interval_counters(state)
    state.update({
        "running": False,
        "phase": "failed",
        "stage": "worker-error",
        "error": message,
        "finishedAt": int(time.time() * 1000),
        "currentSymbol": None,
    })
    state.pop("workerPid", None)
    try:
        atomic_json(state_path, state)
    except Exception as persist_error:
        try:
            append_log(log_path, f"无法保存 worker 失败状态：{type(persist_error).__name__}: {persist_error}")
        except OSError:
            pass


def run_worker(args: argparse.Namespace) -> int:
    intervals = list(dict.fromkeys(item.strip() for item in args.intervals.split(",") if item.strip()))
    symbols = list(dict.fromkeys(item.strip().upper() for item in args.symbols.split(",") if item.strip()))
    if not intervals or any(interval not in SUPPORTED_INTERVALS for interval in intervals) or len(symbols) < 2:
        append_log(args.log_file, "训练 worker 参数无效")
        return 2

    state = load_state(args.state_file)
    if state.get("jobId") != args.job_id:
        append_log(args.log_file, "训练任务状态与 jobId 不匹配")
        return 2
    state.update({"workerPid": os.getpid(), "running": True, "phase": "running", "stage": "starting", "intervals": intervals, "symbols": symbols})
    if len(intervals) == 1:
        state["interval"] = intervals[0]
    atomic_json(args.state_file, state)
    append_log(args.log_file, f"任务 {args.job_id} 已由独立 worker 接管")

    failures: list[str] = []
    for index, interval in enumerate(intervals, start=1):
        state["intervalIndex"] = index
        result = run_interval(interval, symbols, args.job_id, args.state_file, args.progress_file, args.log_file, state)
        if result["phase"] == "failed":
            failures.append(f"{interval}: {result.get('error') or '候选模型未晋级'}")
        update_interval_counters(state)
        state["running"] = True
        state["stage"] = "starting" if index < len(intervals) else result["phase"]
        atomic_json(args.state_file, state)

    results = state.get("intervalResults", {})
    update_interval_counters(state)
    if len(intervals) == 1:
        state["interval"] = intervals[0]
        single_result = results.get(intervals[0], {})
        state["metrics"] = single_result.get("metrics")
    state["running"] = False
    state["finishedAt"] = int(time.time() * 1000)
    state["stage"] = "finished"
    state["phase"] = final_job_phase(results, intervals)
    state["error"] = "；".join(failures) if failures else None
    state["currentInterval"] = None
    state["currentSymbol"] = None
    state.pop("workerPid", None)
    atomic_json(args.state_file, state)
    successful = sum(1 for interval in intervals if results.get(interval, {}).get("phase") == "completed")
    append_log(args.log_file, f"任务完成：{state['phase']}，成功周期 {successful}/{len(intervals)}")
    return 1 if state["phase"] == "failed" else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Persistent multi-interval prediction training worker")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--intervals", required=True, help="Comma-separated intervals")
    parser.add_argument("--symbols", required=True, help="Comma-separated trading pairs")
    parser.add_argument("--state-file", required=True, type=Path)
    parser.add_argument("--progress-file", required=True, type=Path)
    parser.add_argument("--log-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        return run_worker(args)
    except Exception as error:
        record_worker_failure(args.state_file, args.log_file, error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
