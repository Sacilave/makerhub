from __future__ import annotations

import json
import os
import statistics
import time
from pathlib import Path

from app.core.state_crypto import protect_state_payload, unprotect_state_payload

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "ablation-results.json"
RUNS = 7
ITERATIONS = 1000


def payload() -> dict:
    return {
        "cookies": [
            {"platform": "cn", "cookie": "token=SECRET-CN; refreshToken=REFRESH-CN"},
            {"platform": "global", "cookie": "token=SECRET-GLB; refreshToken=REFRESH-GLB"},
        ],
        "subscriptions": [
            {"id": i, "url": f"https://makerworld.com/models/{i}", "enabled": True}
            for i in range(250)
        ],
        "user": {"username": "admin", "password_hash": "pbkdf2$example"},
    }


def measure(fn) -> dict[str, float]:
    samples = []
    for _ in range(ITERATIONS):
        start = time.perf_counter_ns()
        fn()
        samples.append((time.perf_counter_ns() - start) / 1_000_000)
    samples.sort()
    return {
        "mean_ms": statistics.mean(samples),
        "p50_ms": samples[len(samples) // 2],
        "p95_ms": samples[int(len(samples) * 0.95)],
    }


def run_once() -> dict:
    plain = payload()
    encoded = json.dumps(plain, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    encrypted = protect_state_payload("app_config", plain)
    encrypted_bytes = json.dumps(encrypted, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {
        "size_bytes": {"plaintext": len(encoded), "envelope": len(encrypted_bytes)},
        "secret_visible": {
            "plaintext": b"SECRET-CN" in encoded,
            "envelope": b"SECRET-CN" in encrypted_bytes,
        },
        "latency": {
            "json_encode": measure(lambda: json.dumps(plain, ensure_ascii=False, sort_keys=True)),
            "encrypt": measure(lambda: protect_state_payload("app_config", plain)),
            "decrypt": measure(lambda: unprotect_state_payload("app_config", encrypted)),
        },
    }


def main() -> int:
    if not os.getenv("MAKERHUB_DATA_ENCRYPTION_KEY"):
        os.environ["MAKERHUB_DATA_ENCRYPTION_KEY"] = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    runs = [run_once() for _ in range(RUNS)]
    result = {"runs": runs}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
