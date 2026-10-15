-- migrate:atomic-rebuild
-- The migrator disables foreign keys before BEGIN and atomically commits the
-- rebuild, foreign-key verification and migration receipt, or restores all three.
-- Existing agreements retain their exact v1 policy; v2 is a tokenless draft.
CREATE TABLE payment_agreements_v2_rebuild (
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
    total_cents INTEGER NOT NULL,
    reservation_cents INTEGER NULL DEFAULT 4900,
    balance_cents INTEGER NOT NULL,
    balance_due_at_utc TEXT NULL,
    balance_timezone TEXT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_RESERVATION',
    provider TEXT NULL,
    public_token_hash BLOB NULL UNIQUE,
    link_expires_at TEXT NULL,
    link_revoked_at TEXT NULL,
    terms_version TEXT NOT NULL,
    reservation_policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    link_expired_event_at TEXT NULL,
    contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version IN (1, 2)),
    payment_mode TEXT NULL,
    initial_cents INTEGER NULL,
    operation_id TEXT NULL UNIQUE,
    operation_json TEXT NULL,
    operation_digest TEXT NULL,
    configuration_id TEXT NULL,
    configuration_digest TEXT NULL,
    CHECK (
        (contract_version = 1
            AND payment_mode IS NULL AND initial_cents IS NULL
            AND operation_id IS NULL AND operation_json IS NULL AND operation_digest IS NULL
            AND configuration_id IS NULL AND configuration_digest IS NULL
            AND total_cents > 4900 AND reservation_cents IS NOT NULL AND reservation_cents = 4900
            AND balance_cents = total_cents - reservation_cents
            AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL
            AND public_token_hash IS NOT NULL)
        OR
        (contract_version = 2
            AND payment_mode IS NOT NULL AND payment_mode IN ('retainer_50', 'full_upfront', 'fixed_49_reservation')
            AND typeof(total_cents) = 'integer' AND total_cents BETWEEN 1 AND 1000000000
            AND initial_cents IS NOT NULL AND typeof(initial_cents) = 'integer' AND initial_cents > 0
            AND typeof(balance_cents) = 'integer' AND balance_cents >= 0
            AND total_cents = initial_cents + balance_cents
            AND status = 'DRAFT_INTERNAL' AND provider IS NULL AND public_token_hash IS NULL
            AND link_revoked_at IS NULL AND link_expired_event_at IS NULL
            AND operation_id IS NOT NULL AND length(operation_id) = 64 AND operation_id NOT GLOB '*[^a-f0-9]*'
            AND operation_json IS NOT NULL AND typeof(operation_json) = 'text' AND length(CAST(operation_json AS BLOB)) BETWEEN 1 AND 196608
            AND operation_digest IS NOT NULL AND length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^a-f0-9]*'
            AND configuration_id IS NOT NULL AND length(configuration_id) BETWEEN 1 AND 96
            AND configuration_digest IS NOT NULL AND length(configuration_digest) = 64 AND configuration_digest NOT GLOB '*[^a-f0-9]*'
            AND (
                (payment_mode = 'retainer_50' AND reservation_cents IS NULL
                    AND initial_cents = (total_cents + 1) / 2 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
                OR (payment_mode = 'full_upfront' AND reservation_cents IS NULL
                    AND initial_cents = total_cents AND balance_cents = 0
                    AND balance_due_at_utc IS NULL AND balance_timezone IS NULL)
                OR (payment_mode = 'fixed_49_reservation' AND reservation_cents IS NOT NULL AND reservation_cents = 4900
                    AND initial_cents = 4900 AND total_cents > 4900 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
            ))
    )
);

INSERT INTO payment_agreements_v2_rebuild (
    id, public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version,
    recipient_name, recipient_email, recipient_phone, service_name, event_at_utc,
    event_location, internal_notes, currency, total_cents, reservation_cents,
    balance_cents, balance_due_at_utc, balance_timezone, status, provider,
    public_token_hash, link_expires_at, link_revoked_at, terms_version,
    reservation_policy_version, created_at, updated_at, link_expired_event_at
)
SELECT
    id, public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version,
    recipient_name, recipient_email, recipient_phone, service_name, event_at_utc,
    event_location, internal_notes, currency, total_cents, reservation_cents,
    balance_cents, balance_due_at_utc, balance_timezone, status, provider,
    public_token_hash, link_expires_at, link_revoked_at, terms_version,
    reservation_policy_version, created_at, updated_at, link_expired_event_at
FROM payment_agreements;

DROP TABLE payment_agreements;
ALTER TABLE payment_agreements_v2_rebuild RENAME TO payment_agreements;
CREATE INDEX idx_payment_agreements_due ON payment_agreements(status, balance_due_at_utc);
CREATE INDEX idx_payment_agreements_source_quote ON payment_agreements(source_quote_id, source_quote_version);

CREATE TABLE payment_schedules_v2_rebuild (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    agreement_id INTEGER NOT NULL REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('RESERVATION', 'INITIAL', 'BALANCE')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    due_at_utc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    paid_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agreement_id, kind)
);
INSERT INTO payment_schedules_v2_rebuild
    (id, public_uuid, agreement_id, kind, amount_cents, due_at_utc, status, paid_at, created_at, updated_at)
SELECT id, public_uuid, agreement_id, kind, amount_cents, due_at_utc, status, paid_at, created_at, updated_at
FROM payment_schedules;
DROP TABLE payment_schedules;
ALTER TABLE payment_schedules_v2_rebuild RENAME TO payment_schedules;
CREATE INDEX idx_payment_schedules_due ON payment_schedules(status, due_at_utc);

-- Guard the version discriminator and immutable draft, including direct SQL.
-- A future operational activation requires a separately reviewed migration.
CREATE TRIGGER payment_agreements_version_immutable
BEFORE UPDATE ON payment_agreements
WHEN NEW.contract_version <> OLD.contract_version OR OLD.contract_version = 2
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_AGREEMENT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER payment_schedules_versioned_insert
BEFORE INSERT ON payment_schedules
WHEN EXISTS (
    SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
        (a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE'))
        OR (a.contract_version = 2 AND (
            NEW.status <> 'DRAFT' OR NEW.paid_at IS NOT NULL OR typeof(NEW.amount_cents) <> 'integer'
            OR NOT (
                (NEW.kind = 'INITIAL' AND a.payment_mode IN ('retainer_50', 'full_upfront') AND NEW.amount_cents = a.initial_cents AND NEW.due_at_utc = a.created_at)
                OR (NEW.kind = 'RESERVATION' AND a.payment_mode = 'fixed_49_reservation' AND NEW.amount_cents = 4900 AND NEW.due_at_utc = a.created_at)
                OR (NEW.kind = 'BALANCE' AND a.balance_cents > 0 AND NEW.amount_cents = a.balance_cents AND NEW.due_at_utc = a.balance_due_at_utc)
            )
        ))
    )
)
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_SCHEDULE_VERSION_MISMATCH');
END;

CREATE TRIGGER payment_schedules_versioned_update
BEFORE UPDATE ON payment_schedules
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version = 2)
    OR EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE'))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_SCHEDULE_VERSION_MISMATCH');
END;
