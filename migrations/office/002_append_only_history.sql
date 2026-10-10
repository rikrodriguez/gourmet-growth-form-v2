-- Keep 001 immutable after application. Harden the nullable CHECK and add a
-- complete append-only history without deleting or replacing existing state.
ALTER TABLE office_demo.states DROP CONSTRAINT states_payload_check;
ALTER TABLE office_demo.states ADD CONSTRAINT states_payload_check CHECK ((
  payload->>'version' = '1' AND payload->>'mode' = 'simulation' AND
  payload->'office'->>'syntheticOnly' = 'true'
) IS TRUE);

CREATE TABLE office_demo.history_events (
  state_id text NOT NULL REFERENCES office_demo.states(id),
  history_id text NOT NULL,
  record jsonb NOT NULL CHECK ((
    record->'evidence'->>'simulated' = 'true' AND
    record->>'caseId' IN ('demo-aurora', 'demo-cedar', 'demo-harbor') AND
    record->>'id' = history_id
  ) IS TRUE),
  PRIMARY KEY (state_id, history_id)
);

INSERT INTO office_demo.history_events(state_id, history_id, record)
SELECT states.id, entry.key, entry.value FROM office_demo.states states,
LATERAL jsonb_each(states.payload->'office'->'history') entry;

CREATE FUNCTION office_demo.prevent_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OFFICE_EVENTS_APPEND_ONLY';
END;
$$;

CREATE TRIGGER command_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
ON office_demo.command_events FOR EACH STATEMENT EXECUTE FUNCTION office_demo.prevent_event_mutation();

CREATE TRIGGER history_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
ON office_demo.history_events FOR EACH STATEMENT EXECUTE FUNCTION office_demo.prevent_event_mutation();
