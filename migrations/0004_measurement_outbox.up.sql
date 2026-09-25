ALTER TABLE growth_v2.leads
  ADD COLUMN google_ads_conversion_id varchar(64),
  ADD CONSTRAINT leads_google_ads_conversion_id_format CHECK (
    google_ads_conversion_id IS NULL OR google_ads_conversion_id ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT leads_google_ads_conversion_id_unique UNIQUE (google_ads_conversion_id);

CREATE TABLE growth_v2.lead_measurement_consents (
  lead_id uuid PRIMARY KEY REFERENCES growth_v2.leads(lead_id) ON DELETE CASCADE,
  consent_version smallint NOT NULL,
  ad_storage varchar(10) NOT NULL,
  ad_user_data varchar(10) NOT NULL,
  ad_personalization varchar(10) NOT NULL,
  consent_recorded_at timestamptz NOT NULL,
  source varchar(30) NOT NULL DEFAULT 'client_explicit',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_measurement_consent_version CHECK (consent_version = 1),
  CONSTRAINT lead_measurement_ad_storage CHECK (ad_storage IN ('granted', 'denied')),
  CONSTRAINT lead_measurement_ad_user_data CHECK (ad_user_data IN ('granted', 'denied')),
  CONSTRAINT lead_measurement_ad_personalization CHECK (ad_personalization IN ('granted', 'denied')),
  CONSTRAINT lead_measurement_consent_source CHECK (source = 'client_explicit')
);

CREATE TABLE growth_v2.measurement_outbox (
  outbox_id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_v2.leads(lead_id) ON DELETE CASCADE,
  destination varchar(30) NOT NULL,
  event_name varchar(40) NOT NULL,
  dedupe_key varchar(64) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(100),
  last_error_code varchar(100),
  provider_request_id varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT measurement_outbox_lead_event_unique UNIQUE (lead_id, destination, event_name),
  CONSTRAINT measurement_outbox_destination_allowed CHECK (destination = 'google_ads'),
  CONSTRAINT measurement_outbox_event_allowed CHECK (event_name = 'generate_lead'),
  CONSTRAINT measurement_outbox_status_allowed CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead')),
  CONSTRAINT measurement_outbox_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT measurement_outbox_lock_state CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  )
);

CREATE INDEX measurement_outbox_ready_idx
  ON growth_v2.measurement_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE growth_v2.measurement_worker_state (
  worker_name varchar(100) PRIMARY KEY,
  last_started_at timestamptz NOT NULL,
  last_poll_at timestamptz NOT NULL,
  last_success_at timestamptz,
  git_sha varchar(64),
  updated_at timestamptz NOT NULL DEFAULT now()
);
