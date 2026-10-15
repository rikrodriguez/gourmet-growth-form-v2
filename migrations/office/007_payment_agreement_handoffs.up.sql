-- Prepared migration for review. No Office startup applies this file.
-- Apply only after 005_event_quotes.up.sql in an explicitly approved namespace.
-- Operations and exact receiver receipts are encrypted; command and actor
-- references in the append-only journal are digests, never browser credentials.
CREATE TABLE gourmet_quotes.payment_handoffs_v2 (
  event_key text NOT NULL REFERENCES gourmet_quotes.events(key),
  operation_id text NOT NULL CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100),
  payload jsonb NOT NULL CHECK ((
    jsonb_typeof(payload) = 'object' AND
    payload ?& ARRAY['version','iv','ciphertext','tag'] AND
    payload - ARRAY['version','iv','ciphertext','tag'] = '{}'::jsonb AND
    payload->'version' = '1'::jsonb AND
    jsonb_typeof(payload->'iv') = 'string' AND
    jsonb_typeof(payload->'ciphertext') = 'string' AND
    jsonb_typeof(payload->'tag') = 'string' AND
    payload->>'iv' ~ '^[A-Za-z0-9_-]{16}$' AND
    payload->>'tag' ~ '^[A-Za-z0-9_-]{22}$' AND
    payload->>'ciphertext' ~ '^[A-Za-z0-9_-]+$' AND
    octet_length(payload::text) <= 710000
  ) IS TRUE),
  PRIMARY KEY(event_key,operation_id)
);
CREATE TABLE gourmet_quotes.payment_handoff_events_v2 (
  event_key text NOT NULL,
  operation_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  previous_digest text CHECK (previous_digest ~ '^[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('intent_committed','delivery_claimed','receipt_reconciled','delivery_rejected','delivery_ambiguous')),
  at_ms bigint NOT NULL CHECK (at_ms >= 0),
  PRIMARY KEY(event_key,operation_id,revision),
  FOREIGN KEY(event_key,operation_id) REFERENCES gourmet_quotes.payment_handoffs_v2(event_key,operation_id),
  CHECK ((revision = 1) = (previous_digest IS NULL))
);
CREATE TABLE gourmet_quotes.payment_handoff_commands_v2 (
  event_key text NOT NULL,
  command_digest text NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  actor_digest text NOT NULL CHECK (actor_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  operation_id text NOT NULL,
  PRIMARY KEY(event_key,command_digest),
  FOREIGN KEY(event_key,operation_id) REFERENCES gourmet_quotes.payment_handoffs_v2(event_key,operation_id)
);
CREATE FUNCTION gourmet_quotes.payment_handoff_append_only_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append only'; END $$;
CREATE TRIGGER payment_handoff_event_immutable_v2 BEFORE UPDATE OR DELETE ON gourmet_quotes.payment_handoff_events_v2
  FOR EACH ROW EXECUTE FUNCTION gourmet_quotes.payment_handoff_append_only_v2();
CREATE TRIGGER payment_handoff_command_immutable_v2 BEFORE UPDATE OR DELETE ON gourmet_quotes.payment_handoff_commands_v2
  FOR EACH ROW EXECUTE FUNCTION gourmet_quotes.payment_handoff_append_only_v2();
