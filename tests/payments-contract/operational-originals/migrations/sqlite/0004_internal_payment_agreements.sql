-- migrate:non-transactional
-- SQLite requires a table rebuild to make the Monday reference nullable.
-- No customer CRM data is introduced: these are immutable source references only.
CREATE TABLE payment_agreements_rebuild (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    monday_item_id TEXT NULL UNIQUE,
    source_lead_id TEXT NULL,
    source_quote_id TEXT NULL,
    source_quote_version TEXT NULL,
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

INSERT INTO payment_agreements_rebuild (
    id, public_uuid, monday_item_id, recipient_name, recipient_email, recipient_phone,
    service_name, event_at_utc, event_location, internal_notes, currency, total_cents,
    reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status,
    provider, public_token_hash, link_expires_at, link_revoked_at, terms_version,
    reservation_policy_version, created_at, updated_at
)
SELECT
    id, public_uuid, monday_item_id, recipient_name, recipient_email, recipient_phone,
    service_name, event_at_utc, event_location, internal_notes, currency, total_cents,
    reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status,
    provider, public_token_hash, link_expires_at, link_revoked_at, terms_version,
    reservation_policy_version, created_at, updated_at
FROM payment_agreements;

DROP TABLE payment_agreements;
ALTER TABLE payment_agreements_rebuild RENAME TO payment_agreements;
CREATE INDEX idx_payment_agreements_due ON payment_agreements(status, balance_due_at_utc);
CREATE INDEX idx_payment_agreements_source_quote ON payment_agreements(source_quote_id, source_quote_version);
