-- migrate:atomic-rebuild
-- Atomically preserve the v1/v2 ledger and add issued checkout children.
-- Source drafts remain immutable and tokenless. No provider is invoked by SQL.
DROP TRIGGER payment_agreements_version_immutable;
DROP TRIGGER payment_schedules_versioned_insert;
DROP TRIGGER payment_schedules_versioned_update;

CREATE TABLE payment_agreements_v3_rebuild (
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
    contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version IN (1, 2, 3)),
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
        OR
        (contract_version = 3
            AND currency = 'USD'
            AND payment_mode IS NOT NULL AND payment_mode IN ('retainer_50', 'full_upfront', 'fixed_49_reservation')
            AND typeof(total_cents) = 'integer' AND typeof(initial_cents) = 'integer' AND typeof(balance_cents) = 'integer' AND total_cents BETWEEN 1 AND 1000000000
            AND initial_cents IS NOT NULL AND initial_cents > 0 AND balance_cents >= 0
            AND total_cents = initial_cents + balance_cents
            AND public_token_hash IS NOT NULL AND typeof(public_token_hash) = 'blob' AND length(public_token_hash) = 32
            AND operation_id IS NULL AND operation_json IS NULL AND operation_digest IS NULL
            AND configuration_id IS NULL AND configuration_digest IS NULL
            AND source_lead_id IS NOT NULL AND source_quote_id IS NOT NULL AND source_quote_version IS NOT NULL
            AND monday_item_id IS NULL AND internal_notes IS NULL
            AND length(terms_version) = 64 AND terms_version NOT GLOB '*[^a-f0-9]*'
            AND reservation_policy_version = 'checkout-v1-' || payment_mode
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

INSERT INTO payment_agreements_v3_rebuild (id, public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, recipient_phone, service_name, event_at_utc, event_location, internal_notes, currency, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status, provider, public_token_hash, link_expires_at, link_revoked_at, terms_version, reservation_policy_version, created_at, updated_at, link_expired_event_at, contract_version, payment_mode, initial_cents, operation_id, operation_json, operation_digest, configuration_id, configuration_digest)
SELECT id, public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, recipient_phone, service_name, event_at_utc, event_location, internal_notes, currency, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status, provider, public_token_hash, link_expires_at, link_revoked_at, terms_version, reservation_policy_version, created_at, updated_at, link_expired_event_at, contract_version, payment_mode, initial_cents, operation_id, operation_json, operation_digest, configuration_id, configuration_digest FROM payment_agreements;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'payment_agreements_v3_rebuild', seq FROM sqlite_sequence WHERE name = 'payment_agreements'
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'payment_agreements_v3_rebuild');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'payment_agreements'), 0)) WHERE name = 'payment_agreements_v3_rebuild';
DROP TABLE payment_agreements;
ALTER TABLE payment_agreements_v3_rebuild RENAME TO payment_agreements;
CREATE INDEX idx_payment_agreements_due ON payment_agreements(status, balance_due_at_utc);
CREATE INDEX idx_payment_agreements_source_quote ON payment_agreements(source_quote_id, source_quote_version);

CREATE TABLE payment_consents_checkout_rebuild (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_uuid TEXT NOT NULL UNIQUE,
    agreement_id INTEGER NOT NULL REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    provider TEXT NULL,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE', 'INITIAL_PAYMENT', 'ONE_TIME_PAYMENT')),
    terms_version TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    scheduled_charge_at TEXT NULL,
    accepted_at TEXT NOT NULL,
    ip_hash BLOB NULL,
    user_agent_summary TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agreement_id, consent_type)
);

INSERT INTO payment_consents_checkout_rebuild (id, public_uuid, agreement_id, provider, consent_type, terms_version, amount_cents, scheduled_charge_at, accepted_at, ip_hash, user_agent_summary, created_at)
SELECT id, public_uuid, agreement_id, provider, consent_type, terms_version, amount_cents, scheduled_charge_at, accepted_at, ip_hash, user_agent_summary, created_at FROM payment_consents;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'payment_consents_checkout_rebuild', seq FROM sqlite_sequence WHERE name = 'payment_consents'
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'payment_consents_checkout_rebuild');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'payment_consents'), 0)) WHERE name = 'payment_consents_checkout_rebuild';
DROP TABLE payment_consents;
ALTER TABLE payment_consents_checkout_rebuild RENAME TO payment_consents;
CREATE INDEX idx_payment_consents_agreement ON payment_consents(agreement_id);

CREATE TABLE payment_checkout_issuances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issuance_id TEXT NOT NULL UNIQUE CHECK (length(issuance_id) = 64 AND issuance_id NOT GLOB '*[^a-f0-9]*'),
    parent_draft_id INTEGER NOT NULL UNIQUE REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    checkout_agreement_id INTEGER NOT NULL UNIQUE REFERENCES payment_agreements(id) ON DELETE RESTRICT,
    source_operation_id TEXT NOT NULL CHECK (length(source_operation_id) = 64 AND source_operation_id NOT GLOB '*[^a-f0-9]*'),
    source_operation_digest TEXT NOT NULL CHECK (length(source_operation_digest) = 64 AND source_operation_digest NOT GLOB '*[^a-f0-9]*'),
    conditions_json TEXT NOT NULL CHECK (typeof(conditions_json) = 'text' AND length(CAST(conditions_json AS BLOB)) BETWEEN 1 AND 262144),
    conditions_digest TEXT NOT NULL CHECK (length(conditions_digest) = 64 AND conditions_digest NOT GLOB '*[^a-f0-9]*'),
    issued_at_ms INTEGER NOT NULL CHECK (typeof(issued_at_ms) = 'integer' AND issued_at_ms BETWEEN 0 AND 8640000000000000),
    created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) = 26
        AND substr(created_at, 20, 1) = '.'
        AND substr(created_at, 21, 6) NOT GLOB '*[^0-9]*'
        AND strftime('%Y-%m-%d %H:%M:%S', substr(created_at, 1, 19)) IS NOT NULL
        AND strftime('%Y-%m-%d %H:%M:%S', substr(created_at, 1, 19)) = substr(created_at, 1, 19)),
    CHECK (parent_draft_id <> checkout_agreement_id)
);

CREATE TRIGGER payment_agreements_version_immutable
BEFORE UPDATE ON payment_agreements
WHEN NEW.contract_version <> OLD.contract_version OR OLD.contract_version = 2
    OR (OLD.contract_version = 3 AND (
        NOT (NEW.id IS OLD.id) OR
        NOT (NEW.public_uuid IS OLD.public_uuid) OR
        NOT (NEW.monday_item_id IS OLD.monday_item_id) OR
        NOT (NEW.source_lead_id IS OLD.source_lead_id) OR
        NOT (NEW.source_quote_id IS OLD.source_quote_id) OR
        NOT (NEW.source_quote_version IS OLD.source_quote_version) OR
        NOT (NEW.recipient_name IS OLD.recipient_name) OR
        NOT (NEW.recipient_email IS OLD.recipient_email) OR
        NOT (NEW.recipient_phone IS OLD.recipient_phone) OR
        NOT (NEW.service_name IS OLD.service_name) OR
        NOT (NEW.event_at_utc IS OLD.event_at_utc) OR
        NOT (NEW.event_location IS OLD.event_location) OR
        NOT (NEW.internal_notes IS OLD.internal_notes) OR
        NOT (NEW.currency IS OLD.currency) OR
        NOT (NEW.total_cents IS OLD.total_cents) OR
        NOT (NEW.reservation_cents IS OLD.reservation_cents) OR
        NOT (NEW.balance_cents IS OLD.balance_cents) OR
        NOT (NEW.balance_due_at_utc IS OLD.balance_due_at_utc) OR
        NOT (NEW.balance_timezone IS OLD.balance_timezone) OR
        NOT (NEW.terms_version IS OLD.terms_version) OR
        NOT (NEW.reservation_policy_version IS OLD.reservation_policy_version) OR
        NOT (NEW.public_token_hash IS OLD.public_token_hash) OR
        NOT (NEW.link_expires_at IS OLD.link_expires_at) OR
        NOT (NEW.created_at IS OLD.created_at) OR
        NOT (NEW.payment_mode IS OLD.payment_mode) OR
        NOT (NEW.initial_cents IS OLD.initial_cents)
    ))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_AGREEMENT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER payment_agreements_checkout_insert
BEFORE INSERT ON payment_agreements
WHEN NEW.contract_version = 3 AND (NEW.status <> 'PENDING_CHECKOUT' OR NEW.provider IS NOT NULL OR NEW.link_revoked_at IS NOT NULL OR NEW.link_expired_event_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CHECKOUT_INITIAL_STATE_REQUIRED');
END;

CREATE TRIGGER payment_schedules_versioned_insert
BEFORE INSERT ON payment_schedules
WHEN EXISTS (
        SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
            (a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE'))
            OR (a.contract_version IN (2, 3) AND (
                NEW.status <> CASE WHEN a.contract_version = 2 THEN 'DRAFT' ELSE 'PENDING' END
                OR NEW.paid_at IS NOT NULL OR typeof(NEW.amount_cents) <> 'integer'
                OR NOT ((NEW.kind = 'INITIAL' AND a.payment_mode IN ('retainer_50', 'full_upfront') AND NEW.amount_cents = a.initial_cents AND NEW.due_at_utc = a.created_at)
                    OR (NEW.kind = 'RESERVATION' AND a.payment_mode = 'fixed_49_reservation' AND NEW.amount_cents = 4900 AND NEW.due_at_utc = a.created_at)
                    OR (NEW.kind = 'BALANCE' AND a.balance_cents > 0 AND NEW.amount_cents = a.balance_cents AND NEW.due_at_utc = a.balance_due_at_utc))
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
    OR (EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version = 3)
        AND (NOT (NEW.id IS OLD.id) OR
        NOT (NEW.public_uuid IS OLD.public_uuid) OR
        NOT (NEW.agreement_id IS OLD.agreement_id) OR
        NOT (NEW.kind IS OLD.kind) OR
        NOT (NEW.amount_cents IS OLD.amount_cents) OR
        NOT (NEW.due_at_utc IS OLD.due_at_utc) OR
        NOT (NEW.created_at IS OLD.created_at)))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_SCHEDULE_VERSION_MISMATCH');
END;

CREATE TRIGGER payment_schedules_checkout_delete
BEFORE DELETE ON payment_schedules
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = OLD.agreement_id AND a.contract_version = 3)
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CHECKOUT_SCHEDULE_IMMUTABLE');
END;

CREATE TRIGGER payment_checkout_issuances_source_insert
BEFORE INSERT ON payment_checkout_issuances
WHEN NOT EXISTS (
        SELECT 1 FROM payment_agreements p JOIN payment_agreements c ON c.id = NEW.checkout_agreement_id
        WHERE p.id = NEW.parent_draft_id AND p.contract_version = 2
            AND c.contract_version = 3
            AND p.id <> c.id
            AND p.operation_id = NEW.source_operation_id
            AND p.operation_digest = NEW.source_operation_digest
            AND c.terms_version = NEW.conditions_digest
            AND (c.monday_item_id IS p.monday_item_id)
            AND (c.source_lead_id IS p.source_lead_id)
            AND (c.source_quote_id IS p.source_quote_id)
            AND (c.source_quote_version IS p.source_quote_version)
            AND (c.recipient_name IS p.recipient_name)
            AND (c.recipient_email IS p.recipient_email)
            AND (c.recipient_phone IS p.recipient_phone)
            AND (c.service_name IS p.service_name)
            AND (c.event_at_utc IS p.event_at_utc)
            AND (c.event_location IS p.event_location)
            AND (c.internal_notes IS p.internal_notes)
            AND (c.currency IS p.currency)
            AND (c.total_cents IS p.total_cents)
            AND (c.reservation_cents IS p.reservation_cents)
            AND (c.balance_cents IS p.balance_cents)
            AND (c.balance_due_at_utc IS p.balance_due_at_utc)
            AND (c.balance_timezone IS p.balance_timezone)
            AND (c.payment_mode IS p.payment_mode)
            AND (c.initial_cents IS p.initial_cents)
            AND (c.link_expires_at IS p.link_expires_at)
            AND c.created_at = NEW.created_at
            AND c.created_at >= p.created_at
            AND NEW.issued_at_ms = CAST(strftime('%s', substr(NEW.created_at, 1, 19)) AS INTEGER) * 1000 + CAST(substr(NEW.created_at, 21, 3) AS INTEGER)
    )
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CHECKOUT_SOURCE_MISMATCH');
END;

CREATE TRIGGER payment_checkout_issuances_update
BEFORE UPDATE ON payment_checkout_issuances
WHEN 1 = 1
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CHECKOUT_ISSUANCE_IMMUTABLE');
END;

CREATE TRIGGER payment_checkout_issuances_delete
BEFORE DELETE ON payment_checkout_issuances
WHEN 1 = 1
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CHECKOUT_ISSUANCE_IMMUTABLE');
END;

CREATE TRIGGER payment_consents_versioned_insert
BEFORE INSERT ON payment_consents
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
        a.contract_version = 2
        OR (a.contract_version = 1 AND NEW.consent_type NOT IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE'))
        OR (a.contract_version = 3 AND NOT (
            NEW.terms_version = a.terms_version AND (
                (a.payment_mode = 'full_upfront' AND NEW.consent_type = 'ONE_TIME_PAYMENT' AND NEW.amount_cents = a.total_cents AND NEW.scheduled_charge_at IS NULL)
                OR (a.payment_mode IN ('retainer_50', 'fixed_49_reservation') AND NEW.consent_type = 'INITIAL_PAYMENT' AND NEW.amount_cents = a.initial_cents AND NEW.scheduled_charge_at IS NULL)
                OR (a.payment_mode IN ('retainer_50', 'fixed_49_reservation') AND NEW.consent_type = 'FUTURE_BALANCE_CHARGE' AND NEW.amount_cents = a.balance_cents AND NEW.scheduled_charge_at IS NOT NULL AND NEW.scheduled_charge_at = a.balance_due_at_utc)
            )
        ))
    ))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CONSENT_VERSION_MISMATCH');
END;

CREATE TRIGGER payment_consents_versioned_update
BEFORE UPDATE ON payment_consents
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version IN (2, 3))
    OR EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
        a.contract_version = 2
        OR (a.contract_version = 1 AND NEW.consent_type NOT IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE'))
        OR (a.contract_version = 3 AND NOT (
            NEW.terms_version = a.terms_version AND (
                (a.payment_mode = 'full_upfront' AND NEW.consent_type = 'ONE_TIME_PAYMENT' AND NEW.amount_cents = a.total_cents AND NEW.scheduled_charge_at IS NULL)
                OR (a.payment_mode IN ('retainer_50', 'fixed_49_reservation') AND NEW.consent_type = 'INITIAL_PAYMENT' AND NEW.amount_cents = a.initial_cents AND NEW.scheduled_charge_at IS NULL)
                OR (a.payment_mode IN ('retainer_50', 'fixed_49_reservation') AND NEW.consent_type = 'FUTURE_BALANCE_CHARGE' AND NEW.amount_cents = a.balance_cents AND NEW.scheduled_charge_at IS NOT NULL AND NEW.scheduled_charge_at = a.balance_due_at_utc)
            )
        ))
    ))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_CONSENT_VERSION_MISMATCH');
END;

CREATE TRIGGER provider_resources_checkout_insert
BEFORE INSERT ON provider_resources
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 2)
    OR (NEW.resource_type = 'ORDER' AND NOT EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 3 AND a.payment_mode = 'full_upfront'))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_PROVIDER_RESOURCE_VERSION_MISMATCH');
END;

CREATE TRIGGER provider_resources_checkout_update
BEFORE UPDATE ON provider_resources
WHEN EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 2)
    OR (NEW.resource_type = 'ORDER' AND NOT EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 3 AND a.payment_mode = 'full_upfront'))
    OR (OLD.resource_type = 'ORDER' AND (NOT (NEW.resource_type IS OLD.resource_type) OR NOT (NEW.agreement_id IS OLD.agreement_id)))
BEGIN
    SELECT RAISE(ABORT, 'PAYMENT_PROVIDER_RESOURCE_VERSION_MISMATCH');
END;
