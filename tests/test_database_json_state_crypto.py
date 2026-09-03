from __future__ import annotations

from copy import deepcopy
import pytest
from app.core import database_json_state as state_store
from app.core import state_crypto

TEST_KEY = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv(state_crypto.KEY_ENV, TEST_KEY)
    monkeypatch.delenv(state_crypto.KEY_FILE_ENV, raising=False)
    monkeypatch.delenv(state_crypto.PREVIOUS_KEYS_FILE_ENV, raising=False)
    monkeypatch.setenv(state_crypto.REQUIRE_ENV, "true")
    monkeypatch.setattr(state_store, "database_configured", lambda: True)
    monkeypatch.setattr(state_store, "database_driver_available", lambda: True)


def test_save_encrypts_database_value_but_returns_plaintext(monkeypatch):
    captured = {}
    def fake_save(key, value):
        captured[key] = deepcopy(value)
        return value
    monkeypatch.setattr(state_store, "save_json_state", fake_save)
    plain = {"cookies": [{"cookie": "token=secret"}]}
    returned = state_store.save_database_json_state("app_config", plain)
    assert returned == plain
    assert state_crypto.is_encrypted_state_payload(captured["app_config"])
    assert "secret" not in str(captured["app_config"])


def test_load_legacy_plaintext_lazily_migrates(monkeypatch):
    storage = {"app_config": {"cookie": "legacy-secret"}}
    monkeypatch.setattr(state_store, "load_json_state", lambda key: deepcopy(storage.get(key)))
    def fake_update(key, default, mutator, expected_revision=None):
        current = deepcopy(storage.get(key, default))
        updated = mutator(current)
        storage[key] = deepcopy(updated)
        return deepcopy(updated), 1
    monkeypatch.setattr(state_store, "update_json_state", fake_update)
    result = state_store.load_database_json_state("app_config", {})
    assert result == {"cookie": "legacy-secret"}
    assert state_crypto.is_encrypted_state_payload(storage["app_config"])
    assert "legacy-secret" not in str(storage["app_config"])


def test_atomic_update_mutator_only_sees_plaintext(monkeypatch):
    storage = {"app_config": state_crypto.protect_state_payload("app_config", {"count": 1})}
    def fake_update(key, default, mutator, expected_revision=None):
        updated = mutator(deepcopy(storage.get(key, default)))
        storage[key] = deepcopy(updated)
        return deepcopy(updated), 9
    monkeypatch.setattr(state_store, "update_json_state", fake_update)
    def mutate(payload):
        assert not state_crypto.is_encrypted_state_payload(payload)
        payload["count"] += 1
        return payload
    result, revision = state_store.update_database_json_state("app_config", {"count": 0}, mutate)
    assert result == {"count": 2}
    assert revision == 9
    assert state_crypto.is_encrypted_state_payload(storage["app_config"])


def test_jsonb_summary_rejects_protected_state():
    with pytest.raises(RuntimeError):
        state_store.load_database_json_state_array_summary("app_config", "cookies")
