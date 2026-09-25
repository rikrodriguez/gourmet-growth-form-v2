DROP TABLE IF EXISTS growth_v2.measurement_worker_state;
DROP TABLE IF EXISTS growth_v2.measurement_outbox;
DROP TABLE IF EXISTS growth_v2.lead_measurement_consents;
ALTER TABLE growth_v2.leads DROP COLUMN IF EXISTS google_ads_conversion_id;
