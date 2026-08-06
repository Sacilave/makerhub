from __future__ import annotations

import ctypes
import gc
from pathlib import Path
from typing import Any


def process_rss_mib(*, status_path: Path | str = Path("/proc/self/status")) -> float:
    try:
        content = Path(status_path).read_text(encoding="utf-8")
    except OSError:
        return 0.0
    for line in content.splitlines():
        if not line.startswith("VmRSS:"):
            continue
        fields = line.split()
        try:
            return round(float(fields[1]) / 1024.0, 1)
        except (IndexError, TypeError, ValueError):
            return 0.0
    return 0.0


def release_process_memory() -> dict[str, Any]:
    collected = gc.collect()
    trimmed = False
    try:
        malloc_trim = ctypes.CDLL(None).malloc_trim
        malloc_trim.argtypes = [ctypes.c_size_t]
        malloc_trim.restype = ctypes.c_int
        trimmed = bool(malloc_trim(0))
    except Exception:
        pass
    return {"collected": int(collected), "trimmed": trimmed}
