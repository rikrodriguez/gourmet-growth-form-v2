ALTER TABLE growth_v2.leads
  ADD COLUMN monday_item_id bigint,
  ADD COLUMN monday_item_url text,
  ADD COLUMN monday_synced_at timestamptz,
  ADD COLUMN crm_status varchar(20) NOT NULL DEFAULT 'not_queued',
  ADD COLUMN crm_last_error_code varchar(80),
  ADD COLUMN crm_last_error_at timestamptz,
  ADD CONSTRAINT leads_monday_item_id_unique UNIQUE (monday_item_id),
  ADD CONSTRAINT leads_crm_status_allowed CHECK (crm_status IN (
    'not_queued', 'pending', 'synced', 'retrying', 'dead'
  )),
  ADD CONSTRAINT leads_monday_url_safe CHECK (
    monday_item_url IS NULL OR monday_item_url ~ '^https://[a-z0-9-]+\.monday\.com/boards/[0-9]+/pulses/[0-9]+$'
  );

CREATE TABLE growth_v2.crm_outbox (
  outbox_id uuid PRIMARY KEY,
  lead_id uuid NOT NULL UNIQUE REFERENCES growth_v2.leads(lead_id) ON DELETE CASCADE,
  provider varchar(20) NOT NULL DEFAULT 'monday',
  operation varchar(30) NOT NULL DEFAULT 'create_lead',
  payload_version integer NOT NULL DEFAULT 1,
  delivered_version integer NOT NULL DEFAULT 0,
  dedupe_key uuid NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(100),
  create_attempted_at timestamptz,
  last_error_code varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT crm_outbox_provider_allowed CHECK (provider = 'monday'),
  CONSTRAINT crm_outbox_operation_allowed CHECK (operation IN ('create_lead', 'update_lead')),
  CONSTRAINT crm_outbox_status_allowed CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead')),
  CONSTRAINT crm_outbox_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT crm_outbox_version_order CHECK (payload_version >= 1 AND delivered_version >= 0 AND delivered_version <= payload_version),
  CONSTRAINT crm_outbox_lock_state CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  )
);

CREATE INDEX crm_outbox_ready_idx
  ON growth_v2.crm_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE growth_v2.crm_worker_state (
  worker_name varchar(100) PRIMARY KEY,
  last_started_at timestamptz NOT NULL,
  last_poll_at timestamptz NOT NULL,
  last_success_at timestamptz,
  git_sha varchar(64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

