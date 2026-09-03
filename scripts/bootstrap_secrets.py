from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"
SECRETS_DIR = ROOT / "secrets"
PRIMARY_KEY = SECRETS_DIR / "state-encryption-key"
PREVIOUS_KEYS = SECRETS_DIR / "state-encryption-previous-keys"


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        if fd >= 0:
            os.close(fd)


def _state_key() -> str:
    raw = secrets.token_bytes(32)
    return "base64:" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _env_template() -> str:
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    text = text.replace("MAKERHUB_POSTGRES_PASSWORD=\n", f"MAKERHUB_POSTGRES_PASSWORD={secrets.token_hex(32)}\n", 1)
    text = text.replace("MAKERHUB_CLOAKBROWSER_AUTH_TOKEN=\n", f"MAKERHUB_CLOAKBROWSER_AUTH_TOKEN={secrets.token_urlsafe(48)}\n", 1)
    return text


def main() -> int:
    created: list[Path] = []
    if not ENV_PATH.exists():
        _write_private(ENV_PATH, _env_template())
        created.append(ENV_PATH)
    if not PRIMARY_KEY.exists():
        _write_private(PRIMARY_KEY, _state_key() + "\n")
        created.append(PRIMARY_KEY)
    if not PREVIOUS_KEYS.exists():
        _write_private(PREVIOUS_KEYS, "# One old base64/hex key per line during key rotation.\n")
        created.append(PREVIOUS_KEYS)
    for path in (ENV_PATH, PRIMARY_KEY, PREVIOUS_KEYS):
        if path.exists():
            try:
                path.chmod(0o600)
            except OSError:
                pass
    if created:
        print("Created:")
        for path in created:
            print(f"  - {path.relative_to(ROOT)}")
    else:
        print("Secrets already exist; nothing was overwritten.")
    print("Next: docker compose up -d --build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
