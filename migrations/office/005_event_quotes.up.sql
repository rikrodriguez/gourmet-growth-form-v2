-- Prepared, isolated migration. Existing Office startup never applies this file.
-- Business content, contacts, actors and command keys exist only in authenticated
-- encrypted payloads. The separate immutable audit contains hashes only.
CREATE SCHEMA gourmet_quotes;

CREATE TABLE gourmet_quotes.events (
  key text PRIMARY KEY CHECK (key ~ '^event-quote-[a-f0-9]{64}$'),
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
    length(payload->>'ciphertext') <= 699051 AND
    octet_length(payload::text) <= 700000
  ) IS TRUE),
  audit_digest text NOT NULL CHECK (audit_digest ~ '^[a-f0-9]{64}$'),
  previous_audit_digest text CHECK (previous_audit_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((revision = 1) = (previous_audit_digest IS NULL))
);

CREATE TABLE gourmet_quotes.audit_events (
  event_key text NOT NULL REFERENCES gourmet_quotes.events(key),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  previous_digest text CHECK (previous_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_key, revision),
  CHECK ((revision = 1) = (previous_digest IS NULL))
);

CREATE FUNCTION gourmet_quotes.validate_event_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.previous_audit_digest IS NOT NULL THEN
      RAISE EXCEPTION 'QUOTE_HISTORY_APPEND_ONLY';
    END IF;
  ELSE
    IF NEW.key <> OLD.key OR NEW.revision <> OLD.revision + 1 OR
       NEW.previous_audit_digest IS DISTINCT FROM OLD.audit_digest OR
       NEW.audit_digest = OLD.audit_digest OR NEW.receipt_digest = OLD.receipt_digest OR
       NEW.payload = OLD.payload THEN
      RAISE EXCEPTION 'QUOTE_HISTORY_APPEND_ONLY';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION gourmet_quotes.append_event_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gourmet_quotes.audit_events(event_key,revision,digest,previous_digest,receipt_digest)
  VALUES(NEW.key,NEW.revision,NEW.audit_digest,NEW.previous_audit_digest,NEW.receipt_digest);
  RETURN NEW;
END;
$$;

CREATE FUNCTION gourmet_quotes.prevent_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'QUOTE_HISTORY_APPEND_ONLY';
END;
$$;

CREATE FUNCTION gourmet_quotes.prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'QUOTE_AUDIT_APPEND_ONLY';
END;
$$;

CREATE FUNCTION gourmet_quotes.require_internal_audit_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <> 2 THEN RAISE EXCEPTION 'QUOTE_AUDIT_INTERNAL_ONLY'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_append BEFORE INSERT OR UPDATE ON gourmet_quotes.events
FOR EACH ROW EXECUTE FUNCTION gourmet_quotes.validate_event_append();
CREATE TRIGGER event_audit AFTER INSERT OR UPDATE ON gourmet_quotes.events
FOR EACH ROW EXECUTE FUNCTION gourmet_quotes.append_event_audit();
CREATE TRIGGER event_no_removal BEFORE DELETE OR TRUNCATE ON gourmet_quotes.events
FOR EACH STATEMENT EXECUTE FUNCTION gourmet_quotes.prevent_history_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON gourmet_quotes.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION gourmet_quotes.prevent_audit_mutation();
CREATE TRIGGER audit_internal_insert BEFORE INSERT ON gourmet_quotes.audit_events
FOR EACH ROW EXECUTE FUNCTION gourmet_quotes.require_internal_audit_insert();
