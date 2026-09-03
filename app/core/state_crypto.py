from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ENVELOPE_FIELD = "_makerhub_encrypted_state"
ENVELOPE_VERSION = 1
ENVELOPE_ALGORITHM = "AES-256-GCM"
KEY_ENV = "MAKERHUB_DATA_ENCRYPTION_KEY"
KEY_FILE_ENV = "MAKERHUB_DATA_ENCRYPTION_KEY_FILE"
PREVIOUS_KEYS_FILE_ENV = "MAKERHUB_DATA_ENCRYPTION_PREVIOUS_KEYS_FILE"
REQUIRE_ENV = "MAKERHUB_REQUIRE_STATE_ENCRYPTION"

# Keep this set intentionally small. States queried directly with PostgreSQL JSONB
# operators must NOT be added here unless those server-side queries are removed.
PROTECTED_STATE_KEYS = frozenset(
    {
        "app_config",
        "auth_sessions",
        "auth_login_failures",
        "model_shares",
        "bambu_studio_download_secret",
        "cookie_source_sync_state",
        "cookie_source_inventory",
    }
)


class StateEncryptionError(RuntimeError):
    """Persistent state could not be safely encrypted or decrypted."""


@dataclass(frozen=True)
class StateEncryptionStatus:
    configured: bool
    required: bool
    key_id: str
    previous_key_count: int
    protected_state_count: int


def _env_bool(name: str, default: bool = False) -> bool:
    raw = str(os.getenv(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on", "enabled"}


def state_encryption_required() -> bool:
    return _env_bool(REQUIRE_ENV, False)


def _read_primary_key_text() -> str:
    key_file = str(os.getenv(KEY_FILE_ENV, "") or "").strip()
    if key_file:
        try:
            return Path(key_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise StateEncryptionError(f"无法读取状态加密密钥文件：{key_file}") from exc
    return str(os.getenv(KEY_ENV, "") or "").strip()


def _read_previous_key_texts() -> list[str]:
    key_file = str(os.getenv(PREVIOUS_KEYS_FILE_ENV, "") or "").strip()
    if not key_file:
        return []
    try:
        lines = Path(key_file).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise StateEncryptionError(f"无法读取旧状态加密密钥文件：{key_file}") from exc
    result: list[str] = []
    for line in lines:
        text = line.strip()
        if text and not text.startswith("#") and text not in result:
            result.append(text)
    return result


def _urlsafe_b64decode(value: str) -> bytes:
    text = str(value or "").strip()
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode((text + padding).encode("ascii"))
    except Exception as exc:
        raise StateEncryptionError("状态加密密钥不是有效的 base64url。") from exc


def decode_data_encryption_key(raw: str) -> bytes:
    text = str(raw or "").strip()
    if not text:
        return b""
    if text.startswith("base64:"):
        key = _urlsafe_b64decode(text.removeprefix("base64:"))
    elif text.startswith("hex:"):
        try:
            key = bytes.fromhex(text.removeprefix("hex:"))
        except ValueError as exc:
            raise StateEncryptionError("状态加密密钥不是有效的十六进制。") from exc
    else:
        key = _urlsafe_b64decode(text)
    if len(key) != 32:
        raise StateEncryptionError("状态加密密钥必须正好是 32 字节（AES-256）。")
    return key


def _key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:16] if key else ""


def load_data_encryption_key(*, required: bool | None = None) -> bytes:
    key = decode_data_encryption_key(_read_primary_key_text())
    must_exist = state_encryption_required() if required is None else bool(required)
    if must_exist and not key:
        raise StateEncryptionError(
            f"状态加密已设为必需，但 {KEY_ENV} / {KEY_FILE_ENV} 未配置。"
        )
    return key


def load_data_encryption_keyring(*, required: bool | None = None) -> tuple[bytes, dict[str, bytes]]:
    primary = load_data_encryption_key(required=required)
    ring: dict[str, bytes] = {}
    if primary:
        ring[_key_id(primary)] = primary
    for raw in _read_previous_key_texts():
        key = decode_data_encryption_key(raw)
        ring.setdefault(_key_id(key), key)
    return primary, ring


def state_encryption_status() -> StateEncryptionStatus:
    primary, ring = load_data_encryption_keyring(required=False)
    return StateEncryptionStatus(
        configured=bool(primary),
        required=state_encryption_required(),
        key_id=_key_id(primary),
        previous_key_count=max(len(ring) - (1 if primary else 0), 0),
        protected_state_count=len(PROTECTED_STATE_KEYS),
    )


def is_protected_state_key(key: str) -> bool:
    return str(key or "").strip() in PROTECTED_STATE_KEYS


def is_encrypted_state_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    envelope = payload.get(ENVELOPE_FIELD)
    return isinstance(envelope, dict) and int(envelope.get("version") or 0) == ENVELOPE_VERSION


def encrypted_state_key_id(payload: Any) -> str:
    if not is_encrypted_state_payload(payload):
        return ""
    return str(payload[ENVELOPE_FIELD].get("key_id") or "").strip()


def _aad(state_key: str) -> bytes:
    return f"makerhub:state:{state_key}:v{ENVELOPE_VERSION}".encode("utf-8")


def _canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")


def _encrypt_plaintext(state_key: str, payload: dict[str, Any], key: bytes) -> dict[str, Any]:
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, _canonical_json_bytes(payload), _aad(state_key))
    return {
        ENVELOPE_FIELD: {
            "version": ENVELOPE_VERSION,
            "algorithm": ENVELOPE_ALGORITHM,
            "key_id": _key_id(key),
            "nonce": base64.urlsafe_b64encode(nonce).decode("ascii").rstrip("="),
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii").rstrip("="),
        }
    }


def protect_state_payload(state_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    clean_key = str(state_key or "").strip()
    if not is_protected_state_key(clean_key):
        return payload
    if not isinstance(payload, dict):
        raise StateEncryptionError("受保护状态必须是 JSON 对象。")
    if is_encrypted_state_payload(payload):
        return payload

    key = load_data_encryption_key(required=None)
    if not key:
        # Developer/file-mode compatibility. Canonical hardened Compose sets
        # MAKERHUB_REQUIRE_STATE_ENCRYPTION=true, so production fails closed.
        return payload
    return _encrypt_plaintext(clean_key, payload, key)


def _decrypt_with_key(state_key: str, payload: dict[str, Any], key: bytes) -> dict[str, Any]:
    envelope = payload[ENVELOPE_FIELD]
    try:
        nonce = _urlsafe_b64decode(str(envelope.get("nonce") or ""))
        ciphertext = _urlsafe_b64decode(str(envelope.get("ciphertext") or ""))
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, _aad(state_key))
        decoded = json.loads(plaintext.decode("utf-8"))
    except (InvalidTag, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StateEncryptionError(
            "受保护状态解密失败：密钥错误、状态 key 不匹配或密文已损坏。"
        ) from exc
    if not isinstance(decoded, dict):
        raise StateEncryptionError("受保护状态解密后不是 JSON 对象。")
    return decoded


def unprotect_state_payload(state_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    clean_key = str(state_key or "").strip()
    if not isinstance(payload, dict):
        raise StateEncryptionError("状态 payload 必须是 JSON 对象。")
    if not is_encrypted_state_payload(payload):
        if is_protected_state_key(clean_key) and state_encryption_required():
            # A configured key is allowed to read legacy plaintext so startup
            # migration can atomically encrypt it. Missing key still fails closed.
            load_data_encryption_key(required=True)
        return payload

    envelope = payload[ENVELOPE_FIELD]
    if str(envelope.get("algorithm") or "") != ENVELOPE_ALGORITHM:
        raise StateEncryptionError("不支持的状态加密算法。")
    primary, ring = load_data_encryption_keyring(required=True)
    del primary
    expected_key_id = str(envelope.get("key_id") or "").strip()
    key = ring.get(expected_key_id)
    if not key:
        raise StateEncryptionError(
            "状态密文使用的密钥不在当前 keyring；请恢复原密钥或将旧密钥临时加入轮换文件。"
        )
    return _decrypt_with_key(clean_key, payload, key)


def reencrypt_state_payload(state_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Re-encrypt an envelope with the current primary key."""
    clean_key = str(state_key or "").strip()
    if not is_protected_state_key(clean_key):
        return payload
    plaintext = unprotect_state_payload(clean_key, payload) if is_encrypted_state_payload(payload) else payload
    key = load_data_encryption_key(required=True)
    return _encrypt_plaintext(clean_key, plaintext, key)


def migrate_protected_states() -> dict[str, Any]:
    """Atomically encrypt legacy plaintext and rotate envelopes to the primary key."""
    status = state_encryption_status()
    if not status.configured:
        if status.required:
            load_data_encryption_key(required=True)
        return {
            "enabled": False,
            "migrated": [],
            "rotated": [],
            "already_encrypted": [],
            "missing": [],
        }

    from app.core.database import load_json_state, update_json_state

    result = {
        "enabled": True,
        "migrated": [],
        "rotated": [],
        "already_encrypted": [],
        "missing": [],
    }
    for state_key in sorted(PROTECTED_STATE_KEYS):
        current = load_json_state(state_key)
        if current is None:
            result["missing"].append(state_key)
            continue
        if not isinstance(current, dict):
            raise StateEncryptionError(f"受保护状态 {state_key} 不是 JSON 对象。")

        current_encrypted = is_encrypted_state_payload(current)
        current_key_id = encrypted_state_key_id(current)
        if current_encrypted:
            unprotect_state_payload(state_key, current)
            if current_key_id == status.key_id:
                result["already_encrypted"].append(state_key)
                continue

        def migrate_latest(latest: dict[str, Any]) -> dict[str, Any]:
            if not isinstance(latest, dict):
                raise StateEncryptionError(f"受保护状态 {state_key} 不是 JSON 对象。")
            if is_encrypted_state_payload(latest):
                if encrypted_state_key_id(latest) == status.key_id:
                    unprotect_state_payload(state_key, latest)
                    return latest
                return reencrypt_state_payload(state_key, latest)
            return protect_state_payload(state_key, latest)

        updated, _revision = update_json_state(state_key, current, migrate_latest)
        unprotect_state_payload(state_key, updated)
        if current_encrypted:
            result["rotated"].append(state_key)
        else:
            result["migrated"].append(state_key)
    return result
