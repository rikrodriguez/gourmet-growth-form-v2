CREATE TABLE customers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL,
    phone VARCHAR(32) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_customers_public_uuid (public_uuid),
    KEY idx_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_agreements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    customer_id BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    total_cents BIGINT UNSIGNED NOT NULL,
    reservation_cents BIGINT UNSIGNED NOT NULL DEFAULT 4900,
    balance_cents BIGINT UNSIGNED NOT NULL,
    balance_due_at_utc DATETIME(6) NOT NULL,
    balance_timezone VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    provider VARCHAR(32) NULL,
    public_token_hash BINARY(32) NOT NULL,
    link_expires_at DATETIME(6) NULL,
    link_revoked_at DATETIME(6) NULL,
    terms_version VARCHAR(64) NOT NULL,
    reservation_policy_version VARCHAR(64) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_agreements_public_uuid (public_uuid),
    UNIQUE KEY uq_payment_agreements_public_token_hash (public_token_hash),
    KEY idx_payment_agreements_customer (customer_id),
    KEY idx_payment_agreements_due (status, balance_due_at_utc),
    CONSTRAINT fk_payment_agreements_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
    CONSTRAINT chk_payment_agreements_currency CHECK (currency = 'USD'),
    CONSTRAINT chk_payment_agreements_reservation CHECK (reservation_cents = 4900),
    CONSTRAINT chk_payment_agreements_total CHECK (total_cents > 4900),
    CONSTRAINT chk_payment_agreements_balance CHECK (balance_cents = total_cents - reservation_cents)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_schedules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    agreement_id BIGINT UNSIGNED NOT NULL,
    kind VARCHAR(20) NOT NULL,
    amount_cents BIGINT UNSIGNED NOT NULL,
    due_at_utc DATETIME(6) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    paid_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_schedules_public_uuid (public_uuid),
    UNIQUE KEY uq_payment_schedules_agreement_kind (agreement_id, kind),
    KEY idx_payment_schedules_due (status, due_at_utc),
    CONSTRAINT fk_payment_schedules_agreement FOREIGN KEY (agreement_id) REFERENCES payment_agreements (id),
    CONSTRAINT chk_payment_schedules_kind CHECK (kind IN ('RESERVATION', 'BALANCE')),
    CONSTRAINT chk_payment_schedules_amount CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    schedule_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(32) NOT NULL,
    provider_request_id VARCHAR(190) NULL,
    provider_payment_id VARCHAR(190) NULL,
    idempotency_key VARCHAR(190) NOT NULL,
    amount_cents BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    failure_code VARCHAR(100) NULL,
    failure_message_safe VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_attempts_public_uuid (public_uuid),
    UNIQUE KEY uq_payment_attempts_idempotency (idempotency_key),
    KEY idx_payment_attempts_schedule (schedule_id),
    KEY idx_payment_attempts_provider_payment (provider, provider_payment_id),
    CONSTRAINT fk_payment_attempts_schedule FOREIGN KEY (schedule_id) REFERENCES payment_schedules (id),
    CONSTRAINT chk_payment_attempts_currency CHECK (currency = 'USD'),
    CONSTRAINT chk_payment_attempts_amount CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_consents (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    agreement_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(32) NULL,
    consent_type VARCHAR(50) NOT NULL,
    terms_version VARCHAR(64) NOT NULL,
    amount_cents BIGINT UNSIGNED NOT NULL,
    scheduled_charge_at DATETIME(6) NULL,
    accepted_at DATETIME(6) NOT NULL,
    ip_hash BINARY(32) NULL,
    user_agent_summary VARCHAR(255) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_consents_public_uuid (public_uuid),
    KEY idx_payment_consents_agreement (agreement_id),
    CONSTRAINT fk_payment_consents_agreement FOREIGN KEY (agreement_id) REFERENCES payment_agreements (id),
    CONSTRAINT chk_payment_consents_type CHECK (consent_type IN ('NON_REFUNDABLE_RESERVATION', 'FUTURE_BALANCE_CHARGE')),
    CONSTRAINT chk_payment_consents_amount CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_webhook_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    provider VARCHAR(32) NOT NULL,
    provider_event_id VARCHAR(190) NOT NULL,
    event_type VARCHAR(190) NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    processed_at DATETIME(6) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
    error_safe VARCHAR(500) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_webhook_provider_event (provider, provider_event_id),
    KEY idx_webhook_processing (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE idempotency_keys (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    scope VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(190) NOT NULL,
    request_hash BINARY(32) NOT NULL,
    response_status SMALLINT UNSIGNED NULL,
    response_hash BINARY(32) NULL,
    locked_until DATETIME(6) NULL,
    completed_at DATETIME(6) NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_idempotency_scope_key (scope, idempotency_key),
    KEY idx_idempotency_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    deduplication_key VARCHAR(190) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    recipient_email VARCHAR(254) NOT NULL,
    template_key VARCHAR(100) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(6) NOT NULL,
    locked_until DATETIME(6) NULL,
    last_attempt_at DATETIME(6) NULL,
    sent_at DATETIME(6) NULL,
    failure_safe VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_email_outbox_public_uuid (public_uuid),
    UNIQUE KEY uq_email_outbox_deduplication_key (deduplication_key),
    KEY idx_email_outbox_delivery (status, available_at, locked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_public_uuid CHAR(36) NULL,
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_public_uuid CHAR(36) NULL,
    request_id VARCHAR(64) NULL,
    metadata_json JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_audit_events_public_uuid (public_uuid),
    KEY idx_audit_events_aggregate (aggregate_type, aggregate_public_uuid, created_at),
    KEY idx_audit_events_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    email VARCHAR(254) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_admin_users_public_uuid (public_uuid),
    UNIQUE KEY uq_admin_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    admin_user_id BIGINT UNSIGNED NOT NULL,
    token_hash BINARY(32) NOT NULL,
    csrf_token_hash BINARY(32) NOT NULL,
    user_agent_summary VARCHAR(255) NULL,
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_admin_sessions_public_uuid (public_uuid),
    UNIQUE KEY uq_admin_sessions_token_hash (token_hash),
    KEY idx_admin_sessions_user (admin_user_id),
    KEY idx_admin_sessions_expiry (expires_at),
    CONSTRAINT fk_admin_sessions_user FOREIGN KEY (admin_user_id) REFERENCES admin_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_login_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(254) NOT NULL,
    ip_hash BINARY(32) NOT NULL,
    attempted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    KEY idx_admin_login_attempts_window (email, ip_hash, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
