from __future__ import annotations

import copy
import pytest
from app.core import state_crypto

TEST_KEY = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
OTHER_KEY = "base64:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"


@pytest.fixture(autouse=True)
def encryption_env(monkeypatch):
    monkeypatch.setenv(state_crypto.KEY_ENV, TEST_KEY)
    monkeypatch.delenv(state_crypto.KEY_FILE_ENV, raising=False)
    monkeypatch.delenv(state_crypto.PREVIOUS_KEYS_FILE_ENV, raising=False)
    monkeypatch.setenv(state_crypto.REQUIRE_ENV, "true")


def test_protected_state_is_encrypted_and_round_trips():
    plain = {"cookies": [{"cookie": "token=super-secret"}], "value": 42}
    encrypted = state_crypto.protect_state_payload("app_config", plain)
    assert encrypted != plain
    assert state_crypto.is_encrypted_state_payload(encrypted)
    assert "super-secret" not in str(encrypted)
    assert state_crypto.unprotect_state_payload("app_config", encrypted) == plain


def test_unprotected_state_remains_jsonb_queryable():
    payload = {"queued": [{"status": "paused"}]}
    assert state_crypto.protect_state_payload("archive_queue", payload) is payload
    assert not state_crypto.is_protected_state_key("archive_queue")


def test_ciphertext_tamper_fails_closed():
    encrypted = state_crypto.protect_state_payload("app_config", {"cookie": "secret"})
    tampered = copy.deepcopy(encrypted)
    ciphertext = tampered[state_crypto.ENVELOPE_FIELD]["ciphertext"]
    tampered[state_crypto.ENVELOPE_FIELD]["ciphertext"] = ("A" if ciphertext[0] != "A" else "B") + ciphertext[1:]
    with pytest.raises(state_crypto.StateEncryptionError):
        state_crypto.unprotect_state_payload("app_config", tampered)


def test_aad_prevents_cross_state_replay():
    encrypted = state_crypto.protect_state_payload("app_config", {"cookie": "secret"})
    with pytest.raises(state_crypto.StateEncryptionError):
        state_crypto.unprotect_state_payload("auth_sessions", encrypted)


def test_wrong_key_is_rejected(monkeypatch):
    encrypted = state_crypto.protect_state_payload("app_config", {"cookie": "secret"})
    monkeypatch.setenv(state_crypto.KEY_ENV, OTHER_KEY)
    with pytest.raises(state_crypto.StateEncryptionError):
        state_crypto.unprotect_state_payload("app_config", encrypted)


def test_required_encryption_without_key_fails(monkeypatch):
    monkeypatch.delenv(state_crypto.KEY_ENV, raising=False)
    with pytest.raises(state_crypto.StateEncryptionError):
        state_crypto.protect_state_payload("app_config", {"cookie": "secret"})


def test_legacy_plaintext_can_be_read_for_migration():
    plain = {"cookie": "legacy"}
    assert state_crypto.unprotect_state_payload("app_config", plain) == plain
