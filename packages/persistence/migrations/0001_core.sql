-- Core tenancy substrate (RFC-BaaS §4, §7 · task T6).
--
-- Every tenant-scoped table carries tenant_id NOT NULL from its first
-- migration. Retrofitting namespacing onto populated money records is the one
-- change that is genuinely impossible later, so it is bought now while it
-- costs a column.

-- migrate:up

CREATE TABLE tenant (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL
);

COMMENT ON TABLE tenant IS 'classification: operational. One row until a second tenant exists.';

-- The credential carries the tenant. Resolution is never from a header or a
-- body a caller controls (RFC-BaaS §4).
CREATE TABLE api_client (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  client_id    text NOT NULL UNIQUE,
  secret_hash  text NOT NULL,
  name         text NOT NULL,
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL
);

COMMENT ON COLUMN api_client.secret_hash IS 'classification: secret. bcrypt; never logged, never returned.';

CREATE INDEX api_client_tenant_idx ON api_client (tenant_id);

-- Scope changes are append-only and audited. Finding D2: the incumbent
-- replaces the scope array wholesale with no audit row, and the portal cannot
-- edit scopes at all, so changes are made directly in the database.
CREATE TABLE api_client_scope (
  id             uuid PRIMARY KEY,
  api_client_id  uuid NOT NULL REFERENCES api_client (id),
  scope          text NOT NULL,
  granted_at     timestamptz NOT NULL,
  granted_by     uuid NOT NULL,
  revoked_at     timestamptz,
  revoked_by     uuid,
  reason         text NOT NULL
);

CREATE INDEX api_client_scope_client_idx ON api_client_scope (api_client_id);
CREATE UNIQUE INDEX api_client_scope_live_idx
  ON api_client_scope (api_client_id, scope)
  WHERE revoked_at IS NULL;

-- Immutable audit. No UPDATE or DELETE grant is ever issued on this table;
-- the rule is enforced by a trigger so that it holds even for a superuser
-- connection, which is how the service actually connects today.
CREATE TABLE audit_event (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  occurred_at  timestamptz NOT NULL,
  actor_id     uuid,
  actor_kind   text NOT NULL,
  action       text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_event_tenant_time_idx ON audit_event (tenant_id, occurred_at DESC);
CREATE INDEX audit_event_subject_idx ON audit_event (subject_type, subject_id);

CREATE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

-- Row-level security is written and tested now, running permissive with a
-- single tenant, so that it is exercised code rather than a future project
-- (RFC-BaaS §4).
ALTER TABLE api_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;

-- nullif(..., '') matters. An unset setting reads as NULL, but a setting that
-- was set and then left by a transaction reads as the empty string, and
-- ''::uuid raises rather than denying -- turning a missing tenant context into
-- a 500 instead of an empty result. Comparing against NULL yields NULL, which
-- filters the row out: deny by default.
CREATE POLICY api_client_tenant_isolation ON api_client
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_event_tenant_isolation ON audit_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- migrate:down

DROP POLICY audit_event_tenant_isolation ON audit_event;
DROP POLICY api_client_tenant_isolation ON api_client;
DROP TRIGGER audit_event_no_update ON audit_event;
DROP FUNCTION audit_event_is_append_only();
DROP TABLE audit_event;
DROP TABLE api_client_scope;
DROP TABLE api_client;
DROP TABLE tenant;
