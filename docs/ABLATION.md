# State Encryption Ablation

The storage design was evaluated against a plaintext baseline to check whether protecting application state adds unacceptable overhead.

## Variants

- **Plaintext JSON** — normal JSON serialization without encryption.
- **Whole-state envelope** — the complete sensitive state object is serialized and encrypted with AES-256-GCM before database persistence.

Whole-state encryption was selected because the security boundary is independent of individual schema fields. New fields inside a protected state automatically inherit the same protection.

## Reproduce

```bash
export MAKERHUB_DATA_ENCRYPTION_KEY="base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
python scripts/ablation_state_encryption.py
```

The script performs seven runs and writes raw measurements to `docs/ablation-results.json`.

## Acceptance criteria

1. the plaintext test secret must not appear in the persisted encrypted envelope;
2. decrypt(encrypt(payload)) must reproduce the original payload;
3. encryption/decryption overhead must stay small relative to database and network I/O;
4. large JSONB queue states must remain outside the protected-state set so SQL summary queries continue to work.

## Current measured result

| Metric | Result |
| --- | ---: |
| Plaintext serialized size | 17,018 B |
| AES-GCM envelope size | 22,852 B |
| Storage growth | 34.28% |
| Median-of-run mean encryption latency | 0.240 ms |
| Median-of-run mean decryption latency | 0.169 ms |
| Test secret visible in plaintext | Yes |
| Test secret visible in encrypted envelope | **No** |

The benchmark is a microbenchmark, not a claim about end-to-end MakerWorld download speed. Browser automation, network latency, file size, and platform limits dominate archive workloads.
