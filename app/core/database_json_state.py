from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Callable

from app.core.database import (
    DatabaseUnavailable,
    database_configured,
    database_driver_available,
    load_json_state,
    load_json_state_archive_queue_verification_summary,
    load_json_state_without_initialization,
    load_json_state_array_summary,
    load_json_state_with_revision,
    save_json_state,
    update_json_state,
)
from app.core.state_crypto import (
    encrypted_state_key_id,
    is_encrypted_state_payload,
    is_protected_state_key,
    protect_state_payload,
    reencrypt_state_payload,
    state_encryption_status,
    unprotect_state_payload,
)

JSON_STATE_MAX_ATTEMPTS = 3


def require_database_json_state() -> None:
    if not database_configured():
        raise DatabaseUnavailable("Postgres 未配置，JSON 状态需要数据库。")
    if not database_driver_available():
        raise DatabaseUnavailable("Postgres 驱动未安装，JSON 状态需要数据库。")


def _with_database_json_state_attempts(operation: Callable[[], Any]) -> Any:
    last_exc: Exception | None = None
    for attempt in range(1, JSON_STATE_MAX_ATTEMPTS + 1):
        try:
            return operation()
        except DatabaseUnavailable:
            raise
        except Exception as exc:
            last_exc = exc
            if attempt >= JSON_STATE_MAX_ATTEMPTS:
                break
            time.sleep(0.05 * attempt)
    raise DatabaseUnavailable(f"Postgres JSON 状态操作失败，已尝试 {JSON_STATE_MAX_ATTEMPTS} 次。") from last_exc


def _decrypt_payload(
    clean_key: str,
    payload: Any,
    default: dict[str, Any],
    *,
    migrate: bool = True,
) -> dict[str, Any]:
    candidate = payload if isinstance(payload, dict) else dict(default)
    plaintext = unprotect_state_payload(clean_key, candidate)

    # Normal reads lazily migrate legacy plaintext and rotate envelopes to the
    # current primary key. Revision-sensitive and health-check reads opt out.
    if not migrate or not isinstance(payload, dict) or not is_protected_state_key(clean_key):
        return plaintext

    status = state_encryption_status()
    if not status.configured:
        return plaintext

    needs_rewrite = (
        not is_encrypted_state_payload(payload)
        or encrypted_state_key_id(payload) != status.key_id
    )
    if not needs_rewrite:
        return plaintext

    def migrate_latest(latest: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(latest, dict):
            latest = dict(default)
        if is_encrypted_state_payload(latest):
            if encrypted_state_key_id(latest) == status.key_id:
                unprotect_state_payload(clean_key, latest)
                return latest
            return reencrypt_state_payload(clean_key, latest)
        return protect_state_payload(clean_key, latest)

    migrated, _revision = update_json_state(clean_key, candidate, migrate_latest)
    return unprotect_state_payload(clean_key, migrated)


def load_database_json_state(key: str, default: dict[str, Any]) -> dict[str, Any]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    require_database_json_state()
    payload = _with_database_json_state_attempts(lambda: load_json_state(clean_key))
    return _decrypt_payload(clean_key, payload, default)


def load_database_json_state_without_initialization(key: str, default: dict[str, Any]) -> dict[str, Any]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    require_database_json_state()
    payload = _with_database_json_state_attempts(lambda: load_json_state_without_initialization(clean_key))
    return _decrypt_payload(clean_key, payload, default, migrate=False)


def _require_server_side_json_queryable(clean_key: str) -> None:
    if is_protected_state_key(clean_key):
        raise RuntimeError(
            f"受保护状态 {clean_key} 已做 envelope encryption，不能使用 PostgreSQL JSONB 摘要查询。"
        )


def load_database_json_state_array_summary(key: str, array_field: str, *, limit: int = 5) -> dict[str, Any]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    clean_field = str(array_field or "").strip()
    if not clean_field:
        raise ValueError("JSON 状态数组字段不能为空。")
    _require_server_side_json_queryable(clean_key)
    require_database_json_state()
    payload = _with_database_json_state_attempts(
        lambda: load_json_state_array_summary(clean_key, clean_field, limit=limit)
    )
    if not isinstance(payload, dict):
        return {"items": [], "count": 0}
    items = payload.get("items")
    return {
        "items": items if isinstance(items, list) else [],
        "count": int(payload.get("count") or 0),
    }


def load_database_archive_queue_verification_summary(key: str) -> dict[str, int]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    _require_server_side_json_queryable(clean_key)
    require_database_json_state()
    payload = _with_database_json_state_attempts(
        lambda: load_json_state_archive_queue_verification_summary(clean_key)
    )
    if not isinstance(payload, dict):
        return {"cn": 0, "global": 0}
    return {
        "cn": max(int(payload.get("cn") or 0), 0),
        "global": max(int(payload.get("global") or 0), 0),
    }


def save_database_json_state(key: str, payload: dict[str, Any]) -> dict[str, Any]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    if not isinstance(payload, dict):
        raise ValueError("JSON 状态 payload 必须是对象。")
    require_database_json_state()
    protected = protect_state_payload(clean_key, payload)
    _with_database_json_state_attempts(lambda: save_json_state(clean_key, protected))
    return payload


def load_database_json_state_with_revision(key: str, default: dict[str, Any]) -> tuple[dict[str, Any], int]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    require_database_json_state()
    payload, revision = _with_database_json_state_attempts(
        lambda: load_json_state_with_revision(clean_key)
    )
    return (_decrypt_payload(clean_key, payload, default, migrate=False), int(revision or 0))


def update_database_json_state(
    key: str,
    default: dict[str, Any],
    mutator: Callable[[dict[str, Any]], dict[str, Any] | None],
    *,
    expected_revision: int | None = None,
) -> tuple[dict[str, Any], int]:
    clean_key = str(key or "").strip()
    if not clean_key:
        raise ValueError("JSON 状态 key 不能为空。")
    if not callable(mutator):
        raise TypeError("JSON 状态 mutator 必须可调用。")
    require_database_json_state()

    protected_default = protect_state_payload(clean_key, dict(default))

    def checked_mutator(current: dict[str, Any]) -> dict[str, Any]:
        plaintext = _decrypt_payload(clean_key, current, default, migrate=False)
        result = mutator(plaintext)
        payload = plaintext if result is None else result
        if not isinstance(payload, dict):
            raise ValueError("JSON 状态 mutator 必须生成对象。")
        return protect_state_payload(clean_key, payload)

    try:
        payload, revision = update_json_state(
            clean_key,
            protected_default,
            checked_mutator,
            expected_revision=expected_revision,
        )
    except DatabaseUnavailable:
        raise
    except Exception:
        # mutator 可能包含副作用，原子更新失败后不能自动重复执行。
        raise
    return _decrypt_payload(clean_key, payload, default, migrate=False), int(revision or 0)


def load_database_json_state_version(key: str) -> str:
    payload = load_database_json_state(key, {})
    for field in ("token", "version", "updated_at", "updatedAt", "last_updated_at"):
        value = str(payload.get(field) or "").strip()
        if value:
            return value
    return ""


def database_json_state_signature(key: str, default: dict[str, Any] | None = None) -> tuple[str, str]:
    payload = load_database_json_state(key, default or {})
    version = ""
    for field in ("token", "version", "updated_at", "updatedAt", "last_updated_at"):
        version = str(payload.get(field) or "").strip()
        if version:
            break
    digest = hashlib.sha1(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return (version, digest)
