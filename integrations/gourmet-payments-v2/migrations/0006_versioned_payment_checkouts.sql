-- migrate:explicit-statements
-- Versioned checkout children leave their immutable v2 source untouched.
-- DDL is journalled per file; a partial execution requires operator recovery.

-- migrate:statement
DROP TRIGGER payment_agreements_version_immutable;

-- migrate:statement
DROP TRIGGER payment_schedules_versioned_insert;

-- migrate:statement
DROP TRIGGER payment_schedules_versioned_update;

-- migrate:statement
ALTER TABLE payment_agreements
    DROP CONSTRAINT chk_payment_agreements_contract_version,
    DROP CONSTRAINT chk_payment_agreements_versioned,
    ADD CONSTRAINT chk_payment_agreements_contract_version CHECK (contract_version IN (1, 2, 3)),
    ADD CONSTRAINT chk_payment_agreements_versioned CHECK (
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
            AND BINARY currency = BINARY 'USD'
            AND payment_mode IS NOT NULL AND BINARY payment_mode IN (BINARY 'retainer_50', BINARY 'full_upfront', BINARY 'fixed_49_reservation')
            AND total_cents BETWEEN 1 AND 1000000000
            AND initial_cents IS NOT NULL AND initial_cents > 0 AND balance_cents >= 0
            AND total_cents = initial_cents + balance_cents
            AND BINARY status = BINARY 'DRAFT_INTERNAL' AND provider IS NULL AND public_token_hash IS NULL
            AND link_revoked_at IS NULL AND link_expired_event_at IS NULL
            AND operation_id IS NOT NULL AND OCTET_LENGTH(operation_id) = 64 AND operation_id REGEXP '^[a-f0-9]{64}$'
            AND operation_json IS NOT NULL AND OCTET_LENGTH(operation_json) BETWEEN 1 AND 196608
            AND operation_digest IS NOT NULL AND OCTET_LENGTH(operation_digest) = 64 AND operation_digest REGEXP '^[a-f0-9]{64}$'
            AND configuration_id IS NOT NULL AND OCTET_LENGTH(configuration_id) BETWEEN 1 AND 96
            AND configuration_digest IS NOT NULL AND OCTET_LENGTH(configuration_digest) = 64 AND configuration_digest REGEXP '^[a-f0-9]{64}$'
            AND (
                (BINARY payment_mode = BINARY 'retainer_50' AND reservation_cents IS NULL
                    AND initial_cents = (total_cents + 1) DIV 2 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
                OR (BINARY payment_mode = BINARY 'full_upfront' AND reservation_cents IS NULL
                    AND initial_cents = total_cents AND balance_cents = 0
                    AND balance_due_at_utc IS NULL AND balance_timezone IS NULL)
                OR (BINARY payment_mode = BINARY 'fixed_49_reservation' AND reservation_cents IS NOT NULL AND reservation_cents = 4900
                    AND initial_cents = 4900 AND total_cents > 4900 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
            ))
        OR
        (contract_version = 3
            AND BINARY currency = BINARY 'USD'
            AND payment_mode IS NOT NULL AND BINARY payment_mode IN (BINARY 'retainer_50', BINARY 'full_upfront', BINARY 'fixed_49_reservation')
            AND total_cents BETWEEN 1 AND 1000000000
            AND initial_cents IS NOT NULL AND initial_cents > 0 AND balance_cents >= 0
            AND total_cents = initial_cents + balance_cents
            AND public_token_hash IS NOT NULL AND OCTET_LENGTH(public_token_hash) = 32
            AND operation_id IS NULL AND operation_json IS NULL AND operation_digest IS NULL
            AND configuration_id IS NULL AND configuration_digest IS NULL
            AND source_lead_id IS NOT NULL AND source_quote_id IS NOT NULL AND source_quote_version IS NOT NULL
            AND monday_item_id IS NULL AND internal_notes IS NULL
            AND OCTET_LENGTH(terms_version) = 64 AND terms_version REGEXP '^[a-f0-9]{64}$'
            AND BINARY terms_version = BINARY LOWER(terms_version)
            AND BINARY reservation_policy_version = BINARY CONCAT('checkout-v1-', payment_mode)
            AND (
                (BINARY payment_mode = BINARY 'retainer_50' AND reservation_cents IS NULL
                    AND initial_cents = (total_cents + 1) DIV 2 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
                OR (BINARY payment_mode = BINARY 'full_upfront' AND reservation_cents IS NULL
                    AND initial_cents = total_cents AND balance_cents = 0
                    AND balance_due_at_utc IS NULL AND balance_timezone IS NULL)
                OR (BINARY payment_mode = BINARY 'fixed_49_reservation' AND reservation_cents IS NOT NULL AND reservation_cents = 4900
                    AND initial_cents = 4900 AND total_cents > 4900 AND balance_cents > 0
                    AND balance_due_at_utc IS NOT NULL AND balance_timezone IS NOT NULL)
            ))
    );

-- migrate:statement
ALTER TABLE payment_consents
    DROP CONSTRAINT chk_payment_consents_type,
    ADD CONSTRAINT chk_payment_consents_type CHECK (consent_type IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE', 'INITIAL_PAYMENT', 'ONE_TIME_PAYMENT'));

-- migrate:statement
ALTER TABLE provider_resources
    DROP CONSTRAINT chk_provider_resources_type,
    ADD CONSTRAINT chk_provider_resources_type CHECK (resource_type IN ('PRODUCT', 'PLAN', 'SUBSCRIPTION', 'ORDER'));

-- migrate:statement
CREATE TABLE payment_checkout_issuances (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    issuance_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_draft_id BIGINT UNSIGNED NOT NULL,
    checkout_agreement_id BIGINT UNSIGNED NOT NULL,
    source_operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_operation_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conditions_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    conditions_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at_ms BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_checkout_issuance_id (issuance_id),
    UNIQUE KEY uq_payment_checkout_parent_draft (parent_draft_id),
    UNIQUE KEY uq_payment_checkout_child (checkout_agreement_id),
    CONSTRAINT fk_payment_checkout_parent FOREIGN KEY (parent_draft_id) REFERENCES payment_agreements(id),
    CONSTRAINT fk_payment_checkout_child FOREIGN KEY (checkout_agreement_id) REFERENCES payment_agreements(id),
    CONSTRAINT chk_payment_checkout_issuance_id CHECK (OCTET_LENGTH(issuance_id) = 64 AND issuance_id REGEXP '^[a-f0-9]{64}$'),
    CONSTRAINT chk_payment_checkout_operation_id CHECK (OCTET_LENGTH(source_operation_id) = 64 AND source_operation_id REGEXP '^[a-f0-9]{64}$'),
    CONSTRAINT chk_payment_checkout_operation_digest CHECK (OCTET_LENGTH(source_operation_digest) = 64 AND source_operation_digest REGEXP '^[a-f0-9]{64}$'),
    CONSTRAINT chk_payment_checkout_conditions_digest CHECK (OCTET_LENGTH(conditions_digest) = 64 AND conditions_digest REGEXP '^[a-f0-9]{64}$'),
    CONSTRAINT chk_payment_checkout_conditions_json CHECK (OCTET_LENGTH(conditions_json) BETWEEN 1 AND 262144),
    CONSTRAINT chk_payment_checkout_issued_at CHECK (issued_at_ms <= 8640000000000000),
    CONSTRAINT chk_payment_checkout_distinct_agreements CHECK (parent_draft_id <> checkout_agreement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- migrate:statement
CREATE TRIGGER payment_agreements_version_immutable
BEFORE UPDATE ON payment_agreements
FOR EACH ROW
BEGIN
    IF NEW.contract_version <> OLD.contract_version OR OLD.contract_version = 2
    OR (OLD.contract_version = 3 AND (
        NOT (NEW.id <=> OLD.id) OR
        NOT (BINARY NEW.public_uuid <=> BINARY OLD.public_uuid) OR
        NOT (BINARY NEW.monday_item_id <=> BINARY OLD.monday_item_id) OR
        NOT (BINARY NEW.source_lead_id <=> BINARY OLD.source_lead_id) OR
        NOT (BINARY NEW.source_quote_id <=> BINARY OLD.source_quote_id) OR
        NOT (BINARY NEW.source_quote_version <=> BINARY OLD.source_quote_version) OR
        NOT (BINARY NEW.recipient_name <=> BINARY OLD.recipient_name) OR
        NOT (BINARY NEW.recipient_email <=> BINARY OLD.recipient_email) OR
        NOT (BINARY NEW.recipient_phone <=> BINARY OLD.recipient_phone) OR
        NOT (BINARY NEW.service_name <=> BINARY OLD.service_name) OR
        NOT (BINARY NEW.event_at_utc <=> BINARY OLD.event_at_utc) OR
        NOT (BINARY NEW.event_location <=> BINARY OLD.event_location) OR
        NOT (BINARY NEW.internal_notes <=> BINARY OLD.internal_notes) OR
        NOT (BINARY NEW.currency <=> BINARY OLD.currency) OR
        NOT (NEW.total_cents <=> OLD.total_cents) OR
        NOT (NEW.reservation_cents <=> OLD.reservation_cents) OR
        NOT (NEW.balance_cents <=> OLD.balance_cents) OR
        NOT (BINARY NEW.balance_due_at_utc <=> BINARY OLD.balance_due_at_utc) OR
        NOT (BINARY NEW.balance_timezone <=> BINARY OLD.balance_timezone) OR
        NOT (BINARY NEW.terms_version <=> BINARY OLD.terms_version) OR
        NOT (BINARY NEW.reservation_policy_version <=> BINARY OLD.reservation_policy_version) OR
        NOT (BINARY NEW.public_token_hash <=> BINARY OLD.public_token_hash) OR
        NOT (BINARY NEW.link_expires_at <=> BINARY OLD.link_expires_at) OR
        NOT (BINARY NEW.created_at <=> BINARY OLD.created_at) OR
        NOT (BINARY NEW.payment_mode <=> BINARY OLD.payment_mode) OR
        NOT (NEW.initial_cents <=> OLD.initial_cents) OR
        NOT (BINARY NEW.customer_id <=> BINARY OLD.customer_id)
    )) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_AGREEMENT_VERSION_IMMUTABLE';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_agreements_checkout_insert
BEFORE INSERT ON payment_agreements
FOR EACH ROW
BEGIN
    IF NEW.contract_version = 3 AND (BINARY NEW.status <> BINARY 'PENDING_CHECKOUT' OR NEW.provider IS NOT NULL OR NEW.link_revoked_at IS NOT NULL OR NEW.link_expired_event_at IS NOT NULL OR NEW.customer_id IS NOT NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CHECKOUT_INITIAL_STATE_REQUIRED';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_schedules_versioned_insert
BEFORE INSERT ON payment_schedules
FOR EACH ROW
BEGIN
    IF EXISTS (
        SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
            (a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE'))
            OR (a.contract_version IN (2, 3) AND (
                BINARY NEW.status <> CASE WHEN a.contract_version = 2 THEN BINARY 'DRAFT' ELSE BINARY 'PENDING' END
                OR NEW.paid_at IS NOT NULL
                OR NOT ((BINARY NEW.kind = BINARY 'INITIAL' AND BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'full_upfront') AND NEW.amount_cents = a.initial_cents AND NEW.due_at_utc = a.created_at)
                    OR (BINARY NEW.kind = BINARY 'RESERVATION' AND BINARY a.payment_mode = BINARY 'fixed_49_reservation' AND NEW.amount_cents = 4900 AND NEW.due_at_utc = a.created_at)
                    OR (BINARY NEW.kind = BINARY 'BALANCE' AND a.balance_cents > 0 AND NEW.amount_cents = a.balance_cents AND NEW.due_at_utc = a.balance_due_at_utc))
            ))
        )
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_SCHEDULE_VERSION_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_schedules_versioned_update
BEFORE UPDATE ON payment_schedules
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version = 2)
    OR EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE'))
    OR (EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version = 3)
        AND (NOT (NEW.id <=> OLD.id) OR
        NOT (BINARY NEW.public_uuid <=> BINARY OLD.public_uuid) OR
        NOT (NEW.agreement_id <=> OLD.agreement_id) OR
        NOT (BINARY NEW.kind <=> BINARY OLD.kind) OR
        NOT (NEW.amount_cents <=> OLD.amount_cents) OR
        NOT (BINARY NEW.due_at_utc <=> BINARY OLD.due_at_utc) OR
        NOT (BINARY NEW.created_at <=> BINARY OLD.created_at))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_SCHEDULE_VERSION_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_schedules_checkout_delete
BEFORE DELETE ON payment_schedules
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = OLD.agreement_id AND a.contract_version = 3) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CHECKOUT_SCHEDULE_IMMUTABLE';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_checkout_issuances_source_insert
BEFORE INSERT ON payment_checkout_issuances
FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM payment_agreements p JOIN payment_agreements c ON c.id = NEW.checkout_agreement_id
        WHERE p.id = NEW.parent_draft_id AND p.contract_version = 2
            AND c.contract_version = 3
            AND p.id <> c.id
            AND BINARY p.operation_id = BINARY NEW.source_operation_id
            AND BINARY p.operation_digest = BINARY NEW.source_operation_digest
            AND BINARY c.terms_version = BINARY NEW.conditions_digest
            AND (BINARY c.monday_item_id <=> BINARY p.monday_item_id)
            AND (BINARY c.source_lead_id <=> BINARY p.source_lead_id)
            AND (BINARY c.source_quote_id <=> BINARY p.source_quote_id)
            AND (BINARY c.source_quote_version <=> BINARY p.source_quote_version)
            AND (BINARY c.recipient_name <=> BINARY p.recipient_name)
            AND (BINARY c.recipient_email <=> BINARY p.recipient_email)
            AND (BINARY c.recipient_phone <=> BINARY p.recipient_phone)
            AND (BINARY c.service_name <=> BINARY p.service_name)
            AND (BINARY c.event_at_utc <=> BINARY p.event_at_utc)
            AND (BINARY c.event_location <=> BINARY p.event_location)
            AND (BINARY c.internal_notes <=> BINARY p.internal_notes)
            AND (BINARY c.currency <=> BINARY p.currency)
            AND (c.total_cents <=> p.total_cents)
            AND (c.reservation_cents <=> p.reservation_cents)
            AND (c.balance_cents <=> p.balance_cents)
            AND (BINARY c.balance_due_at_utc <=> BINARY p.balance_due_at_utc)
            AND (BINARY c.balance_timezone <=> BINARY p.balance_timezone)
            AND (BINARY c.payment_mode <=> BINARY p.payment_mode)
            AND (c.initial_cents <=> p.initial_cents)
            AND (BINARY c.link_expires_at <=> BINARY p.link_expires_at)
            AND c.created_at = NEW.created_at
            AND c.created_at >= p.created_at
            AND c.customer_id IS NULL
            AND p.customer_id IS NULL
            AND NEW.issued_at_ms = TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', NEW.created_at) DIV 1000
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CHECKOUT_SOURCE_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_checkout_issuances_update
BEFORE UPDATE ON payment_checkout_issuances
FOR EACH ROW
BEGIN
    IF 1 = 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CHECKOUT_ISSUANCE_IMMUTABLE';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_checkout_issuances_delete
BEFORE DELETE ON payment_checkout_issuances
FOR EACH ROW
BEGIN
    IF 1 = 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CHECKOUT_ISSUANCE_IMMUTABLE';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_consents_versioned_insert
BEFORE INSERT ON payment_consents
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
        a.contract_version = 2
        OR (a.contract_version = 1 AND NEW.consent_type NOT IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE'))
        OR (a.contract_version = 3 AND NOT (
            BINARY NEW.terms_version = BINARY a.terms_version AND (
                (BINARY a.payment_mode = BINARY 'full_upfront' AND BINARY NEW.consent_type = BINARY 'ONE_TIME_PAYMENT' AND NEW.amount_cents = a.total_cents AND NEW.scheduled_charge_at IS NULL)
                OR (BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'fixed_49_reservation') AND BINARY NEW.consent_type = BINARY 'INITIAL_PAYMENT' AND NEW.amount_cents = a.initial_cents AND NEW.scheduled_charge_at IS NULL)
                OR (BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'fixed_49_reservation') AND BINARY NEW.consent_type = BINARY 'FUTURE_BALANCE_CHARGE' AND NEW.amount_cents = a.balance_cents AND NEW.scheduled_charge_at IS NOT NULL AND NEW.scheduled_charge_at = a.balance_due_at_utc)
            )
        ))
    )) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CONSENT_VERSION_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER payment_consents_versioned_update
BEFORE UPDATE ON payment_consents
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id IN (OLD.agreement_id, NEW.agreement_id) AND a.contract_version IN (2, 3))
    OR EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND (
        a.contract_version = 2
        OR (a.contract_version = 1 AND NEW.consent_type NOT IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE'))
        OR (a.contract_version = 3 AND NOT (
            BINARY NEW.terms_version = BINARY a.terms_version AND (
                (BINARY a.payment_mode = BINARY 'full_upfront' AND BINARY NEW.consent_type = BINARY 'ONE_TIME_PAYMENT' AND NEW.amount_cents = a.total_cents AND NEW.scheduled_charge_at IS NULL)
                OR (BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'fixed_49_reservation') AND BINARY NEW.consent_type = BINARY 'INITIAL_PAYMENT' AND NEW.amount_cents = a.initial_cents AND NEW.scheduled_charge_at IS NULL)
                OR (BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'fixed_49_reservation') AND BINARY NEW.consent_type = BINARY 'FUTURE_BALANCE_CHARGE' AND NEW.amount_cents = a.balance_cents AND NEW.scheduled_charge_at IS NOT NULL AND NEW.scheduled_charge_at = a.balance_due_at_utc)
            )
        ))
    )) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_CONSENT_VERSION_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER provider_resources_checkout_insert
BEFORE INSERT ON provider_resources
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 2)
    OR (NEW.resource_type = 'ORDER' AND (BINARY NEW.resource_type <> BINARY 'ORDER' OR NOT EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 3 AND BINARY a.payment_mode = BINARY 'full_upfront'))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_PROVIDER_RESOURCE_VERSION_MISMATCH';
    END IF;
END;

-- migrate:statement
CREATE TRIGGER provider_resources_checkout_update
BEFORE UPDATE ON provider_resources
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 2)
    OR (NEW.resource_type = 'ORDER' AND (BINARY NEW.resource_type <> BINARY 'ORDER' OR NOT EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 3 AND BINARY a.payment_mode = BINARY 'full_upfront')))
    OR (BINARY OLD.resource_type = BINARY 'ORDER' AND (NOT (BINARY NEW.resource_type <=> BINARY OLD.resource_type) OR NOT (NEW.agreement_id <=> OLD.agreement_id))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_PROVIDER_RESOURCE_VERSION_MISMATCH';
    END IF;
END;
