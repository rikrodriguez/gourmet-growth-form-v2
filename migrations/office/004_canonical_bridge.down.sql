-- Reversal is safe only before this prepared feature has acquired history.
-- A populated feature must be disabled in its caller, retaining this schema.
-- Export/backup, restore verification and a separately approved data-retention
-- decision are required before removing populated storage; this file never does.
DO $$
BEGIN
  LOCK TABLE office_canonical_bridge.workspaces, office_canonical_bridge.audit_events IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM office_canonical_bridge.workspaces) OR
     EXISTS (SELECT 1 FROM office_canonical_bridge.audit_events) THEN
    RAISE EXCEPTION 'BRIDGE_ROLLBACK_REQUIRES_EMPTY_HISTORY';
  END IF;
  DROP SCHEMA office_canonical_bridge CASCADE;
END;
$$;
