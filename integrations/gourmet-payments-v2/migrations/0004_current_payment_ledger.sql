-- migrate:explicit-statements
-- Bridge the unchanged original MySQL/MariaDB 0001..0003 to the current
-- snapshot-based service. DDL commits implicitly: the MySQL migrator journals
-- STARTED/APPLIED with checksums and refuses an unreviewed partial retry.
-- Existing customer rows, agreement IDs, token hashes and foreign keys remain.
-- A legacy full name may need 201 characters: first_name(100), space, last_name(100).
-- Before starting, reject legacy duplicate (agreement_id, consent_type) rows;
-- never delete or merge historical consent evidence to satisfy the new key.

-- migrate:statement
ALTER TABLE payment_agreements
    MODIFY COLUMN customer_id BIGINT UNSIGNED NULL,
    ADD COLUMN monday_item_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN source_lead_id VARCHAR(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN source_quote_id VARCHAR(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN source_quote_version VARCHAR(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN recipient_name VARCHAR(201) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN recipient_email VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN recipient_phone VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN link_expired_event_at DATETIME(6) NULL,
    MODIFY COLUMN event_location VARCHAR(500) NULL,
    ADD UNIQUE KEY uq_payment_agreements_monday_item (monday_item_id),
    ADD KEY idx_payment_agreements_source_quote (source_quote_id, source_quote_version);

-- migrate:statement
UPDATE payment_agreements a
JOIN customers c ON c.id = a.customer_id
SET a.recipient_name = CONCAT_WS(' ', c.first_name, c.last_name),
    a.recipient_email = c.email,
    a.recipient_phone = c.phone,
    a.updated_at = a.updated_at;

-- migrate:statement
ALTER TABLE payment_agreements
    MODIFY COLUMN recipient_name VARCHAR(201) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY COLUMN recipient_email VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- migrate:statement
ALTER TABLE idempotency_keys
    MODIFY COLUMN scope VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY COLUMN idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    ADD COLUMN response_ciphertext MEDIUMBLOB NULL,
    ADD COLUMN response_nonce VARBINARY(12) NULL,
    ADD COLUMN response_tag VARBINARY(16) NULL;

-- migrate:statement
ALTER TABLE payment_attempts
    MODIFY COLUMN provider VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY COLUMN provider_request_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    MODIFY COLUMN provider_payment_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    MODIFY COLUMN idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- migrate:statement
ALTER TABLE provider_resources
    MODIFY COLUMN provider VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY COLUMN external_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY COLUMN parent_external_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    MODIFY COLUMN idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- migrate:statement
ALTER TABLE payment_consents
    ADD UNIQUE KEY uq_payment_consents_agreement_type (agreement_id, consent_type);

-- migrate:statement
ALTER TABLE email_outbox
    MODIFY COLUMN deduplication_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- migrate:statement
CREATE TABLE admin_bootstrap_tokens (
    public_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash BINARY(32) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (public_id),
    UNIQUE KEY uq_admin_bootstrap_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- migrate:statement
CREATE TABLE monday_sync_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    monday_item_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    dedupe_key VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(6) NOT NULL,
    processed_at DATETIME(6) NULL,
    last_error_safe VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_monday_sync_outbox_public_uuid (public_uuid),
    UNIQUE KEY uq_monday_sync_outbox_dedupe (dedupe_key),
    KEY idx_monday_sync_outbox_pending (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- migrate:statement
CREATE TABLE sales_os_event_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    dedupe_key VARCHAR(255) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(6) NOT NULL,
    locked_until DATETIME(6) NULL,
    processed_at DATETIME(6) NULL,
    last_error_safe VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_sales_os_event_outbox_public_uuid (public_uuid),
    UNIQUE KEY uq_sales_os_event_outbox_dedupe (dedupe_key),
    KEY idx_sales_os_event_outbox_delivery (status, available_at, locked_until),
    CONSTRAINT chk_sales_os_event_outbox_type CHECK (event_type IN (
        'payment_link.created', 'reservation.paid', 'balance.scheduled',
        'balance.paid', 'payment.failed', 'payment_link.expired', 'payment_link.revoked'
    )),
    CONSTRAINT chk_sales_os_event_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'SENT', 'FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
