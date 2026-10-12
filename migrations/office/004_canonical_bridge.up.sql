-- Prepared migration: runtime initialization deliberately does not apply this.
-- The dedicated schema never joins or writes office_demo or Monday private data.
CREATE SCHEMA office_canonical_bridge;

CREATE TABLE office_canonical_bridge.workspaces (
  key text PRIMARY KEY CHECK (key ~ '^bridge-[a-f0-9]{64}$'),
  organization_id text NOT NULL CHECK (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$' AND organization_id NOT IN ('__proto__','prototype','constructor')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$' AND actor_id NOT IN ('__proto__','prototype','constructor')),
  partition text NOT NULL CHECK (partition IN ('demo','external')),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key, organization_id, actor_id, partition),
  CHECK ((
    key = 'bridge-' || encode(sha256(convert_to(
      '[' || to_json(organization_id)::text || ',' || to_json(actor_id)::text || ',' || to_json(partition)::text || ']', 'UTF8'
    )), 'hex') AND
    payload->>'schemaVersion' = '1' AND
    payload->'scope' = jsonb_build_object('organizationId',organization_id,'actorId',actor_id,'partition',partition) AND
    (payload->>'revision')::integer = revision AND
    jsonb_typeof(payload->'events') = 'array' AND
    jsonb_array_length(payload->'events') = revision AND
    octet_length(payload::text) <= 1048576
  ) IS TRUE)
);

CREATE TABLE office_canonical_bridge.audit_events (
  workspace_key text NOT NULL,
  organization_id text NOT NULL,
  actor_id text NOT NULL,
  partition text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000),
  logical_revision integer NOT NULL CHECK (logical_revision = revision),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  event_at_ms bigint NOT NULL CHECK (event_at_ms BETWEEN 0 AND 8640000000000000),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_record jsonb NOT NULL CHECK ((
    event_record->>'digest' = digest AND
    (event_record->>'atMs')::bigint = event_at_ms AND
    (event_record->'receipt'->>'revision')::integer = logical_revision AND
    (event_record->'command'->>'expectedRevision')::integer = logical_revision - 1
  ) IS TRUE),
  PRIMARY KEY (workspace_key, revision),
  FOREIGN KEY (workspace_key, organization_id, actor_id, partition)
    REFERENCES office_canonical_bridge.workspaces(key, organization_id, actor_id, partition)
);

CREATE FUNCTION office_canonical_bridge.validate_workspace_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  added jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'BRIDGE_HISTORY_APPEND_ONLY'; END IF;
  ELSE
    IF NEW.key <> OLD.key OR NEW.organization_id <> OLD.organization_id OR
       NEW.actor_id <> OLD.actor_id OR NEW.partition <> OLD.partition OR
       NEW.revision <> OLD.revision + 1 OR
       jsonb_array_length(NEW.payload->'events') <> jsonb_array_length(OLD.payload->'events') + 1 OR
       EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.payload->'events') WITH ORDINALITY AS previous(event, position)
         WHERE previous.event IS DISTINCT FROM NEW.payload->'events'->((previous.position - 1)::integer)) THEN
      RAISE EXCEPTION 'BRIDGE_HISTORY_APPEND_ONLY';
    END IF;
  END IF;
  added := NEW.payload->'events'->(NEW.revision - 1);
  IF (added->'command'->>'expectedRevision')::integer IS DISTINCT FROM NEW.revision - 1 OR
     (added->'receipt'->>'revision')::integer IS DISTINCT FROM NEW.revision OR
     (TG_OP = 'INSERT' AND added->'previousDigest' IS DISTINCT FROM 'null'::jsonb) OR
     (TG_OP = 'UPDATE' AND added->'previousDigest' IS DISTINCT FROM OLD.payload->'events'->(OLD.revision - 1)->'digest') THEN
    RAISE EXCEPTION 'BRIDGE_HISTORY_APPEND_ONLY';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION office_canonical_bridge.append_workspace_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  added jsonb := NEW.payload->'events'->(NEW.revision - 1);
BEGIN
  INSERT INTO office_canonical_bridge.audit_events(workspace_key,organization_id,actor_id,partition,revision,logical_revision,digest,event_at_ms,event_record)
  VALUES(NEW.key,NEW.organization_id,NEW.actor_id,NEW.partition,NEW.revision,(NEW.payload->>'revision')::integer,added->>'digest',(added->>'atMs')::bigint,added);
  RETURN NEW;
END;
$$;

CREATE FUNCTION office_canonical_bridge.prevent_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BRIDGE_HISTORY_APPEND_ONLY';
END;
$$;

CREATE FUNCTION office_canonical_bridge.prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BRIDGE_AUDIT_APPEND_ONLY';
END;
$$;

CREATE FUNCTION office_canonical_bridge.require_internal_audit_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <> 2 THEN RAISE EXCEPTION 'BRIDGE_AUDIT_INTERNAL_ONLY'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_append BEFORE INSERT OR UPDATE ON office_canonical_bridge.workspaces
FOR EACH ROW EXECUTE FUNCTION office_canonical_bridge.validate_workspace_append();
CREATE TRIGGER workspace_audit AFTER INSERT OR UPDATE ON office_canonical_bridge.workspaces
FOR EACH ROW EXECUTE FUNCTION office_canonical_bridge.append_workspace_audit();
CREATE TRIGGER workspace_no_removal BEFORE DELETE OR TRUNCATE ON office_canonical_bridge.workspaces
FOR EACH STATEMENT EXECUTE FUNCTION office_canonical_bridge.prevent_history_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON office_canonical_bridge.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION office_canonical_bridge.prevent_audit_mutation();
CREATE TRIGGER audit_internal_insert BEFORE INSERT ON office_canonical_bridge.audit_events
FOR EACH ROW EXECUTE FUNCTION office_canonical_bridge.require_internal_audit_insert();
