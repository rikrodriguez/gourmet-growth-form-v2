-- The encrypted result is only for authenticated idempotency replays. Public
-- payment tokens remain stored exclusively as hashes on payment_agreements.
ALTER TABLE idempotency_keys ADD COLUMN response_ciphertext BLOB NULL;
ALTER TABLE idempotency_keys ADD COLUMN response_nonce BLOB NULL;
ALTER TABLE idempotency_keys ADD COLUMN response_tag BLOB NULL;

-- Set only when the immutable outbound payment_link.expired event is enqueued.
ALTER TABLE payment_agreements ADD COLUMN link_expired_event_at TEXT NULL;

CREATE TABLE sales_os_event_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'payment_link.created',
        'reservation.paid',
        'balance.scheduled',
        'balance.paid',
        'payment.failed',
        'payment_link.expired',
        'payment_link.revoked'
    )),
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'SENT', 'FAILED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_until TEXT NULL,
    processed_at TEXT NULL,
    last_error_safe TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sales_os_event_outbox_delivery ON sales_os_event_outbox(status, available_at, locked_until);
