CREATE TABLE payment_agreements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    monday_item_id TEXT NOT NULL UNIQUE,
    recipient_name TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_phone TEXT NULL,
    service_name TEXT NOT NULL,
    event_at_utc TEXT NULL,
    event_location TEXT NULL,
    internal_notes TEXT NULL,
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    total_cents INTEGER NOT NULL CHECK (total_cents > 4900),
    reservation_cents INTEGER NOT NULL DEFAULT 4900 CHECK (reservation_cents = 4900),
    balance_cents INTEGER NOT NULL CHECK (balance_cents = total_cents - reservation_cents),
    balance_due_at_utc TEXT NOT NULL,
    balance_timezone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_RESERVATION',
    provider TEXT NULL,
    public_token_hash BLOB NOT NULL UNIQUE,
    link_expires_at TEXT NULL,
    link_revoked_at TEXT NULL,
    terms_version TEXT NOT NULL,
    reservation_policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_payment_agreements_due ON payment_agreements(status, balance_due_at_utc);

CREATE TABLE payment_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    agreement_id INTEGER NOT NULL REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('RESERVATION', 'BALANCE')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    due_at_utc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    paid_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agreement_id, kind)
);
CREATE INDEX idx_payment_schedules_due ON payment_schedules(status, due_at_utc);

CREATE TABLE payment_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    schedule_id INTEGER NOT NULL REFERENCES payment_schedules(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    provider_request_id TEXT NULL,
    provider_payment_id TEXT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    status TEXT NOT NULL DEFAULT 'CREATED',
    failure_code TEXT NULL,
    failure_message_safe TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, provider_payment_id)
);

CREATE TABLE payment_consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    agreement_id INTEGER NOT NULL REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    provider TEXT NULL,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE')),
    terms_version TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    scheduled_charge_at TEXT NULL,
    accepted_at TEXT NOT NULL,
    ip_hash BLOB NULL,
    user_agent_summary TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agreement_id, consent_type)
);

CREATE TABLE provider_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    parent_external_id TEXT NULL,
    agreement_id INTEGER NULL REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    configuration_hash BLOB NOT NULL,
    start_at_utc TEXT NULL,
    approved_at_utc TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, resource_type, external_id),
    UNIQUE (provider, resource_type, configuration_hash)
);

CREATE TABLE provider_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_hash BLOB NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT NULL,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    error_safe TEXT NULL,
    UNIQUE (provider, provider_event_id)
);

CREATE TABLE idempotency_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash BLOB NOT NULL,
    response_status INTEGER NULL,
    response_hash BLOB NULL,
    locked_until TEXT NULL,
    completed_at TEXT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (scope, idempotency_key)
);

CREATE TABLE email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    deduplication_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    template_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_until TEXT NULL,
    last_attempt_at TEXT NULL,
    sent_at TEXT NULL,
    failure_safe TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_email_outbox_delivery ON email_outbox(status, available_at, locked_until);

CREATE TABLE monday_sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    monday_item_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    processed_at TEXT NULL,
    last_error_safe TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_monday_sync_outbox_pending ON monday_sync_outbox(status, available_at);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    actor_type TEXT NOT NULL,
    actor_public_uuid TEXT NULL,
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_public_uuid TEXT NULL,
    request_id TEXT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_events_aggregate ON audit_events(aggregate_type, aggregate_public_uuid, created_at);

CREATE TABLE admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    token_hash BLOB NOT NULL UNIQUE,
    csrf_token_hash BLOB NOT NULL,
    user_agent_summary TEXT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_admin_sessions_active ON admin_sessions(token_hash, expires_at);

CREATE TABLE admin_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ip_hash BLOB NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_admin_login_attempts_rate ON admin_login_attempts(email, ip_hash, attempted_at);
