#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]


def request_json(opener, method: str, url: str, payload: dict | None = None) -> dict:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    with opener.open(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError(f"{url} did not return a JSON object")
    return data


def current_commit() -> str:
    try:
        value = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip().lower()
    except (OSError, subprocess.CalledProcessError):
        return ""
    return value if len(value) == 40 and all(c in "0123456789abcdef" for c in value) else ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only live canary for an already logged-in MakerHub instance.")
    parser.add_argument("--base-url", default="http://127.0.0.1:9042")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", required=True, help="MakerHub admin password, not MakerWorld password")
    parser.add_argument("--url", required=True, help="MakerWorld favorites/collection/author URL to preview")
    parser.add_argument("--min-count", type=int, default=1)
    parser.add_argument("--commit", default="", help="Expected 40-character source commit; defaults to git HEAD")
    parser.add_argument("--output", default="live-canary-result.json")
    args = parser.parse_args()

    commit = args.commit.strip().lower() or current_commit()
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        print("live canary failed: a valid 40-character source commit is required", file=sys.stderr)
        return 5

    base = args.base_url.rstrip("/")
    opener = build_opener(HTTPCookieProcessor(CookieJar()))
    try:
        login = request_json(opener, "POST", f"{base}/api/auth/login", {"username": args.username, "password": args.password})
        if login.get("success") is False:
            raise RuntimeError(f"MakerHub login rejected: {login}")
        ready = request_json(opener, "GET", f"{base}/api/public/health/ready")
        preview = request_json(opener, "POST", f"{base}/api/archive/preview", {"url": args.url})
    except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
        print(f"live canary failed: {exc}", file=sys.stderr)
        return 1

    discovered = int(preview.get("discovered_count") or 0)
    expected = int(preview.get("expected_total") or 0)
    accepted = preview.get("accepted") is not False
    if not accepted:
        print(json.dumps(preview, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    if discovered < max(args.min_count, 0):
        print(f"live canary failed: discovered_count={discovered} < min_count={args.min_count}", file=sys.stderr)
        return 3
    if expected > 0 and discovered != expected:
        print(f"live canary failed: expected_total={expected}, discovered_count={discovered}", file=sys.stderr)
        return 4

    result = {
        "source_commit": commit,
        "ready": ready,
        "url": args.url,
        "accepted": accepted,
        "discovered_count": discovered,
        "expected_total": expected,
        "mode": preview.get("mode"),
        "message": preview.get("message"),
        "result": "PASS",
    }
    output = Path(args.output).expanduser().resolve()
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"evidence: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
