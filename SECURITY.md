# Security

MakerHub is intended to run as a private self-hosted service. Treat its database, browser profiles, archive directory, encryption keys, and backups as sensitive data.

## Safe default deployment

The canonical Compose configuration binds the Web UI and CloakBrowser Manager to localhost by default, does not mount the Docker socket, uses `no-new-privileges`, keeps PostgreSQL on an internal Docker network, and requires an external 256-bit state-encryption key.

Do not expose port 9042 or 9050 directly to the public Internet. For remote access, use a trusted VPN/Tailscale/WireGuard network or a correctly configured HTTPS reverse proxy with strict source controls.

## MakerWorld credentials

MakerHub uses CloakBrowser profiles for interactive MakerWorld authentication. Sensitive application state persisted to PostgreSQL is protected with AES-256-GCM envelope encryption.

The browser profile itself can still contain active cookies and tokens. Database encryption does not make a stolen `data/cloakbrowser/` directory harmless. Protect the host filesystem and backups.

## Encryption key

Generate keys with:

```bash
python scripts/bootstrap_secrets.py
```

The primary key is stored in `secrets/state-encryption-key`. Never commit this file. Losing it can make encrypted application state unrecoverable.

### Key rotation

1. Back up the database and current key.
2. Put the current key in `secrets/state-encryption-previous-keys`.
3. Replace `secrets/state-encryption-key` with a newly generated 32-byte key.
4. Restart MakerHub.
5. Normal state reads and writes lazily rotate encrypted envelopes to the new primary key.
6. After confirming normal operation and a fresh backup, remove the old key from the previous-key file.

## Backups

Back up `data/archive/`, `data/postgres/`, `data/config/`, `data/cloakbrowser/`, and the state-encryption key. Keep the encryption key in a separately protected backup location.

## Reporting a vulnerability

Do not publish real MakerWorld cookies, authentication tokens, database dumps, browser profiles, or encryption keys in a public issue. Use synthetic credentials in reproductions.
