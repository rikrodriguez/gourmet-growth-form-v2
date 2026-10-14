-- Prepared only. No existing server applies this migration.
-- Isolated test_only identity/ACL repository modelled after Sales OS M1.
-- No login, issuer, account provisioning or commercial-session activation.
CREATE SCHEMA gourmet_quote_access;
CREATE TABLE gourmet_quote_access.users (
  organization_id text NOT NULL CHECK (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  mode text NOT NULL CHECK (mode = 'test'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  role text NOT NULL CHECK (role IN ('ADMIN','MANAGER','OPERATIONS','CLOSER','FINANCE')),
  enabled boolean NOT NULL DEFAULT false,
  session_version integer NOT NULL CHECK (session_version > 0),
  PRIMARY KEY (organization_id,workspace_id,mode,actor_id)
);
CREATE TABLE gourmet_quote_access.memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL, workspace_id text NOT NULL, mode text NOT NULL, actor_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  UNIQUE (id,organization_id,workspace_id,mode,actor_id),
  FOREIGN KEY (organization_id,workspace_id,mode,actor_id) REFERENCES gourmet_quote_access.users,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE gourmet_quote_access.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL, workspace_id text NOT NULL, mode text NOT NULL, actor_id text NOT NULL,
  membership_id text NOT NULL,
  membership_version integer NOT NULL CHECK (membership_version > 0),
  session_version integer NOT NULL CHECK (session_version > 0),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  FOREIGN KEY (membership_id,organization_id,workspace_id,mode,actor_id) REFERENCES gourmet_quote_access.memberships(id,organization_id,workspace_id,mode,actor_id)
);
CREATE TABLE gourmet_quote_access.assignments (
  organization_id text NOT NULL, workspace_id text NOT NULL, mode text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  assigned_actor_id text NOT NULL, version integer NOT NULL CHECK (version > 0), active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id,workspace_id,mode,event_id),
  FOREIGN KEY (organization_id,workspace_id,mode,assigned_actor_id) REFERENCES gourmet_quote_access.users(organization_id,workspace_id,mode,actor_id)
);
CREATE TABLE gourmet_quote_access.event_grants (
  organization_id text NOT NULL, workspace_id text NOT NULL, mode text NOT NULL, event_id text NOT NULL, actor_id text NOT NULL,
  assignment_version integer NOT NULL CHECK (assignment_version > 0),
  enabled boolean NOT NULL DEFAULT false,
  can_write boolean NOT NULL DEFAULT false, can_approve boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  PRIMARY KEY (organization_id,workspace_id,mode,event_id,actor_id),
  FOREIGN KEY (organization_id,workspace_id,mode,event_id) REFERENCES gourmet_quote_access.assignments,
  FOREIGN KEY (organization_id,workspace_id,mode,actor_id) REFERENCES gourmet_quote_access.users,
  CHECK (NOT can_approve OR can_write),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
