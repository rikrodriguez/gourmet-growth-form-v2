ALTER TABLE payment_agreements
    ADD COLUMN service_name VARCHAR(180) NOT NULL DEFAULT 'Gourmet service' AFTER customer_id,
    ADD COLUMN event_at_utc DATETIME(6) NULL AFTER service_name,
    ADD COLUMN event_location VARCHAR(255) NULL AFTER event_at_utc,
    ADD COLUMN internal_notes TEXT NULL AFTER event_location;

ALTER TABLE payment_consents
    ADD UNIQUE KEY uq_payment_consents_agreement_provider_type_version (agreement_id, provider, consent_type, terms_version);
