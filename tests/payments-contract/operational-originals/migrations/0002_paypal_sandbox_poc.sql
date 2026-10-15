CREATE TABLE provider_resources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_uuid CHAR(36) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    resource_type VARCHAR(32) NOT NULL,
    external_id VARCHAR(190) NOT NULL,
    parent_external_id VARCHAR(190) NULL,
    agreement_id BIGINT UNSIGNED NULL,
    status VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(190) NOT NULL,
    configuration_hash BINARY(32) NOT NULL,
    start_at_utc DATETIME(6) NULL,
    approved_at_utc DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_provider_resources_public_uuid (public_uuid),
    UNIQUE KEY uq_provider_resources_external (provider, resource_type, external_id),
    UNIQUE KEY uq_provider_resources_idempotency (provider, idempotency_key),
    UNIQUE KEY uq_provider_resources_configuration (provider, resource_type, configuration_hash),
    KEY idx_provider_resources_agreement (agreement_id, provider, resource_type),
    CONSTRAINT fk_provider_resources_agreement FOREIGN KEY (agreement_id) REFERENCES payment_agreements (id),
    CONSTRAINT chk_provider_resources_type CHECK (resource_type IN ('PRODUCT', 'PLAN', 'SUBSCRIPTION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payment_attempts
    ADD UNIQUE KEY uq_payment_attempts_provider_payment (provider, provider_payment_id);
