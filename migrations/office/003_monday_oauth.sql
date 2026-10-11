-- OAuth preparation remains disabled. This separate CAS table stores only
-- records explicitly passed by the Monday service; sensitive values are sealed
-- with AES-256-GCM by that service before insertion. No aggregate is rewritten.
-- Revisions are opaque and monotonic across updates, deletion and recreation.
-- A stale revoke/refresh cannot match a new connection under the same key.
CREATE SEQUENCE office_demo.monday_private_revision_seq AS bigint
  MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 NO CYCLE;

CREATE TABLE office_demo.monday_private_records (
  key text PRIMARY KEY CHECK (
    char_length(key) <= 120 AND key ~ '^monday-[A-Za-z0-9][A-Za-z0-9._:-]*$'
      AND key !~ '[^A-Za-z0-9._:-]'
  ),
  revision bigint NOT NULL DEFAULT nextval('office_demo.monday_private_revision_seq')
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
