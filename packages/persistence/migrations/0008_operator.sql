-- Operators, their roles, and their sessions (task MP-1).
--
-- **Sessions are server-side, not a stateless token.** A stateless JWT would
-- be simpler, and for the mobile surface it is what the BFF already does. It
-- is the wrong choice here: an operator console reads any customer in the
-- tenant, so "revoke this person now" has to mean now, not "within fifteen
-- minutes". Operators are few and a lookup per request costs nothing.
--
-- Roles are granted append-only, like API client scopes, for the same reason:
-- who could approve what, and when, is a question an audit asks afterwards.

-- migrate:up

CREATE TABLE operator (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  issuer      text NOT NULL,
  subject     text NOT NULL,
  email       text,
  display_name text,
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

COMMENT ON TABLE operator IS
  'classification: restricted. Staff identity from the identity provider.';
COMMENT ON COLUMN operator.email IS
  'classification: restricted. Personal data. Held so an audit row names a person rather than a uuid.';
COMMENT ON COLUMN operator.subject IS
  'The OIDC `sub`. Stable for the life of the account at the provider; the natural key together with the issuer.';

-- An identity is (issuer, subject). The same subject from a different issuer
-- is a different person, and assuming otherwise is how a test identity
-- provider becomes a way in.
CREATE UNIQUE INDEX operator_identity_idx ON operator (issuer, subject);
CREATE INDEX operator_tenant_idx ON operator (tenant_id);

CREATE TABLE operator_role (
  id           uuid PRIMARY KEY,
  operator_id  uuid NOT NULL REFERENCES operator (id),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  role         text NOT NULL,
  granted_at   timestamptz NOT NULL,
  granted_by   uuid,
  revoked_at   timestamptz,
  revoked_by   uuid,
  reason       text NOT NULL
);

CREATE UNIQUE INDEX operator_role_live_idx
  ON operator_role (operator_id, role)
  WHERE revoked_at IS NULL;
CREATE INDEX operator_role_operator_idx ON operator_role (operator_id);

CREATE TABLE operator_session (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  operator_id   uuid NOT NULL REFERENCES operator (id),
  -- The token is never stored. A leaked database must not be a set of live
  -- sessions, which is the same reason a password column holds a hash.
  token_hash    text NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz
);

COMMENT ON COLUMN operator_session.token_hash IS
  'classification: secret. SHA-256 of the bearer token. The token itself is never stored.';

CREATE INDEX operator_session_operator_idx ON operator_session (operator_id);
CREATE INDEX operator_session_expiry_idx ON operator_session (expires_at);

ALTER TABLE operator ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_role FORCE ROW LEVEL SECURITY;

CREATE POLICY operator_tenant_isolation ON operator
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY operator_role_tenant_isolation ON operator_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- `operator_session` is deliberately **not** tenant-scoped by policy: a
-- session is looked up by its token hash in order to *discover* which tenant
-- the request belongs to, exactly as `api_client` is. See 0003.

GRANT SELECT, INSERT, UPDATE ON operator TO baas_app;
GRANT SELECT, INSERT, UPDATE ON operator_role TO baas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_session TO baas_app;

-- migrate:down

DROP TABLE operator_session;
DROP TABLE operator_role;
DROP TABLE operator;
