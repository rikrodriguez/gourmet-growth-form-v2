CREATE TABLE admin_bootstrap_tokens (
    public_id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_bootstrap_tokens (public_id, token_hash, expires_at)
VALUES (
    'cb2e1443e319234845709b4ffad56490',
    X'61f3a33d266572f1df5275838f4cf39361bbf4488a5157692c95b36f0d534c2a',
    '2026-09-29 23:10:51'
);
