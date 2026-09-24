CREATE SCHEMA IF NOT EXISTS growth_v2;

CREATE TABLE growth_v2.visitors (
  visitor_id uuid PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visitors_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE growth_v2.sessions (
  session_id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES growth_v2.visitors(visitor_id),
  intent_cluster varchar(40) NOT NULL,
  landing_path varchar(300) NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_step_id varchar(40),
  last_step_index smallint,
  experiment_id varchar(100),
  variant_id varchar(100),
  is_qa boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT sessions_step_index CHECK (last_step_index IS NULL OR last_step_index BETWEEN 1 AND 8),
  CONSTRAINT sessions_seen_order CHECK (last_seen_at >= started_at)
);

CREATE INDEX sessions_visitor_id_idx ON growth_v2.sessions(visitor_id);
CREATE INDEX sessions_last_seen_at_idx ON growth_v2.sessions(last_seen_at);

CREATE TABLE growth_v2.attribution_touches (
  attribution_touch_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES growth_v2.sessions(session_id) ON DELETE CASCADE,
  touch_kind varchar(10) NOT NULL,
  captured_at timestamptz NOT NULL,
  landing_path varchar(300) NOT NULL,
  landing_url_without_pii varchar(500) NOT NULL,
  referrer varchar(200),
  intent_cluster varchar(40) NOT NULL,
  utm_source varchar(200),
  utm_medium varchar(200),
  utm_campaign varchar(200),
  utm_term varchar(200),
  utm_content varchar(200),
  utm_id varchar(200),
  gclid varchar(200),
  gbraid varchar(200),
  wbraid varchar(200),
  gad_source varchar(200),
  gad_campaignid varchar(200),
  adgroupid varchar(200),
  network varchar(200),
  matchtype varchar(200),
  device varchar(200),
  geo varchar(200),
  fbclid varchar(200),
  msclkid varchar(200),
  ttclid varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribution_touch_kind CHECK (touch_kind IN ('first', 'latest')),
  CONSTRAINT attribution_session_touch_unique UNIQUE (session_id, touch_kind)
);

CREATE TABLE growth_v2.events (
  event_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES growth_v2.sessions(session_id),
  visitor_id uuid NOT NULL REFERENCES growth_v2.visitors(visitor_id),
  schema_version varchar(20) NOT NULL,
  event_name varchar(50) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  intent_cluster varchar(40) NOT NULL,
  route varchar(300) NOT NULL,
  step_id varchar(40) NOT NULL,
  step_index smallint NOT NULL,
  step_duration_ms integer,
  session_elapsed_ms integer NOT NULL,
  properties jsonb NOT NULL,
  attribution jsonb NOT NULL,
  experiment_id varchar(100),
  variant_id varchar(100),
  is_qa boolean NOT NULL DEFAULT false,
  CONSTRAINT events_name_allowed CHECK (event_name IN (
    'session_started', 'funnel_resumed', 'step_viewed', 'answer_selected',
    'step_completed', 'back_clicked', 'validation_error', 'phone_captured',
    'form_completed', 'visibility_changed', 'page_exit_signal'
  )),
  CONSTRAINT events_step_index CHECK (step_index BETWEEN 1 AND 8),
  CONSTRAINT events_duration_nonnegative CHECK (step_duration_ms IS NULL OR step_duration_ms >= 0),
  CONSTRAINT events_session_elapsed_nonnegative CHECK (session_elapsed_ms >= 0)
);

CREATE INDEX events_session_occurred_idx ON growth_v2.events(session_id, occurred_at);
CREATE INDEX events_visitor_occurred_idx ON growth_v2.events(visitor_id, occurred_at);
CREATE INDEX events_name_occurred_idx ON growth_v2.events(event_name, occurred_at);

CREATE TABLE growth_v2.leads (
  lead_id uuid PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE REFERENCES growth_v2.sessions(session_id),
  visitor_id uuid NOT NULL REFERENCES growth_v2.visitors(visitor_id),
  intent_cluster varchar(40) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'captured',
  capture_idempotency_key uuid NOT NULL UNIQUE,
  phone_ciphertext text NOT NULL,
  phone_iv varchar(100) NOT NULL,
  phone_auth_tag varchar(100) NOT NULL,
  phone_key_id varchar(100) NOT NULL,
  is_qa boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT leads_status_allowed CHECK (status IN ('captured', 'completed'))
);

CREATE INDEX leads_visitor_id_idx ON growth_v2.leads(visitor_id);

CREATE TABLE growth_v2.lead_answers (
  lead_id uuid NOT NULL REFERENCES growth_v2.leads(lead_id) ON DELETE CASCADE,
  field_key varchar(40) NOT NULL,
  field_value varchar(300),
  cleared_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, field_key),
  CONSTRAINT lead_answers_value_state CHECK ((field_value IS NOT NULL) <> (cleared_at IS NOT NULL)),
  CONSTRAINT lead_answers_key_allowed CHECK (field_key IN (
    'event_type', 'date_window', 'exact_date', 'first_name',
    'guest_range', 'service_style', 'zip_code'
  ))
);
