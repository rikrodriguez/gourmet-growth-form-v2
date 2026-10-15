-- migrate:explicit-statements
-- Add only non-executable v2 drafts. Keep the existing v1 customer relationship,
-- money policy and link hashes; no payment token, provider or outbox is issued.
-- This migration file is journalled DDL, not a rollbackable script.

-- migrate:statement
ALTER TABLE payment_agreements
    DROP CONSTRAINT chk_payment_agreements_reservation,
    DROP CONSTRAINT chk_payment_agreements_total,
    DROP CONSTRAINT chk_payment_agreements_balance,
    MODIFY COLUMN reservation_cents BIGINT UNSIGNED NULL DEFAULT 4900,
    MODIFY COLUMN balance_due_at_utc DATETIME(6) NULL,
    MODIFY COLUMN balance_timezone VARCHAR(64) NULL,
    MODIFY COLUMN public_token_hash BINARY(32) NULL,
    ADD COLUMN contract_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
    ADD COLUMN payment_mode VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN initial_cents BIGINT UNSIGNED NULL,
    ADD COLUMN operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN operation_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN operation_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN configuration_id VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN configuration_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE KEY uq_payment_agreements_operation_id (operation_id),
    ADD CONSTRAINT chk_payment_agreements_contract_version CHECK (contract_version IN (1, 2)),
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
    );

-- migrate:statement
ALTER TABLE payment_schedules
    DROP CONSTRAINT chk_payment_schedules_kind,
    ADD CONSTRAINT chk_payment_schedules_kind CHECK (kind IN ('RESERVATION', 'INITIAL', 'BALANCE'));

-- migrate:statement
CREATE TRIGGER payment_agreements_version_immutable
BEFORE UPDATE ON payment_agreements
FOR EACH ROW
BEGIN
    IF NEW.contract_version <> OLD.contract_version OR OLD.contract_version = 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_AGREEMENT_VERSION_IMMUTABLE';
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
            OR (a.contract_version = 2 AND (
                BINARY NEW.status <> BINARY 'DRAFT' OR NEW.paid_at IS NOT NULL
                OR NOT (
                    (BINARY NEW.kind = BINARY 'INITIAL' AND BINARY a.payment_mode IN (BINARY 'retainer_50', BINARY 'full_upfront') AND NEW.amount_cents = a.initial_cents AND NEW.due_at_utc = a.created_at)
                    OR (BINARY NEW.kind = BINARY 'RESERVATION' AND BINARY a.payment_mode = BINARY 'fixed_49_reservation' AND NEW.amount_cents = 4900 AND NEW.due_at_utc = a.created_at)
                    OR (BINARY NEW.kind = BINARY 'BALANCE' AND a.balance_cents > 0 AND NEW.amount_cents = a.balance_cents AND NEW.due_at_utc = a.balance_due_at_utc)
                )
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
        OR EXISTS (SELECT 1 FROM payment_agreements a WHERE a.id = NEW.agreement_id AND a.contract_version = 1 AND NEW.kind NOT IN ('RESERVATION', 'BALANCE')) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAYMENT_SCHEDULE_VERSION_MISMATCH';
    END IF;
END;
