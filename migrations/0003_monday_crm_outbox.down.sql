DROP TABLE IF EXISTS growth_v2.crm_worker_state;
DROP TABLE IF EXISTS growth_v2.crm_outbox;
ALTER TABLE growth_v2.leads
  DROP CONSTRAINT IF EXISTS leads_monday_url_safe,
  DROP CONSTRAINT IF EXISTS leads_crm_status_allowed,
  DROP CONSTRAINT IF EXISTS leads_monday_item_id_unique,
  DROP COLUMN IF EXISTS crm_last_error_at,
  DROP COLUMN IF EXISTS crm_last_error_code,
  DROP COLUMN IF EXISTS crm_status,
  DROP COLUMN IF EXISTS monday_synced_at,
  DROP COLUMN IF EXISTS monday_item_url,
  DROP COLUMN IF EXISTS monday_item_id;
