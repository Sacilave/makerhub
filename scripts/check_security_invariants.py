from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"SECURITY INVARIANT FAILED: {message}")


def main() -> None:
    compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    crypto = (ROOT / "app/core/state_crypto.py").read_text(encoding="utf-8")

    require("${MAKERHUB_BIND_ADDRESS:-127.0.0.1}:9042:8000" in compose,
            "web UI must bind localhost by default")
    require("MAKERHUB_REQUIRE_STATE_ENCRYPTION: \"true\"" in compose,
            "canonical deployment must fail closed without encryption")
    require("MAKERHUB_DATA_ENCRYPTION_KEY_FILE" in compose,
            "state encryption key must be provided via secret file")
    require("internal: true" in compose,
            "database network must be internal")
    require("no-new-privileges:true" in compose,
            "app/worker containers must use no-new-privileges")

    active = [
        line.strip()
        for line in compose.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    require(not any("/var/run/docker.sock" in line for line in active),
            "Docker socket must not be mounted")

    require("FROM node:24.20.0-trixie-slim" in dockerfile,
            "frontend/runtime bridge must use pinned Node 24.20.0")
    require("FROM python:3.11.16-slim-trixie" in dockerfile,
            "backend must use pinned Python 3.11.16")
    require("image: postgres:16.15-alpine" in compose,
            "PostgreSQL patch release must be pinned")
    require("pillow==12.3.0" in requirements,
            "Pillow must be 12.3.0")
    require("opencv-python-headless==4.14.0.94" in requirements,
            "OpenCV must stay on the audited 4.x update")
    require("cryptography==50.0.1" in requirements,
            "cryptography must be explicitly pinned")

    protected_block = crypto.split("PROTECTED_STATE_KEYS", 1)[1].split(")", 1)[0]
    require('"archive_queue"' not in protected_block,
            "archive_queue must remain JSONB-queryable")

    for path in (ROOT / ".github" / "workflows").glob("*.yml"):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = re.search(r"^\s*uses:\s*([^\s#]+)", line)
            if not match:
                continue
            ref = match.group(1).rsplit("@", 1)[-1]
            require(bool(re.fullmatch(r"[0-9a-f]{40}", ref)),
                    f"{path.name}:{lineno} GitHub Action is not SHA-pinned")

    print("security invariants: OK")


if __name__ == "__main__":
    main()
