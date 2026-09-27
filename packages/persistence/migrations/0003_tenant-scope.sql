-- The application role and the tenant scope (task M1-1, New-14).
--
-- Two corrections to 0001, both found while building the request pipeline.
--
-- 1. `api_client` cannot be tenant-scoped. It is read to *establish* which
--    tenant a request belongs to, so a policy requiring the tenant to already
--    be known is unsatisfiable. `tenant`, `api_client` and `api_client_scope`
--    are registry tables, read before any tenant context exists; their
--    protection is that only the service reads them.
--
-- 2. FORCE ROW LEVEL SECURITY on everything that is genuinely tenant-scoped.
--    Without it the table owner is exempt, so a deployment that happens to
--    connect as the owner has policies in place and no isolation.

-- migrate:up

-- A role that owns nothing and can create nothing. The request pipeline drops
-- to it for the duration of every tenant-scoped transaction, so isolation does
-- not depend on a deployment choosing the right connection user.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'baas_app') THEN
    CREATE ROLE baas_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO baas_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  idempotency_record, effect_outbox, provider_inbox
TO baas_app;

-- Append-only: no UPDATE, no DELETE. The trigger enforces it too, so this is
-- the second of two independent controls rather than the only one.
GRANT SELECT, INSERT ON audit_event TO baas_app;

-- Registry tables: read-only, and read outside any tenant scope.
GRANT SELECT ON tenant, api_client, api_client_scope TO baas_app;

-- `api_client` is a registry table (see note 1 above).
DROP POLICY api_client_tenant_isolation ON api_client;
ALTER TABLE api_client DISABLE ROW LEVEL SECURITY;

-- Owner included (see note 2 above).
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
ALTER TABLE effect_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_inbox FORCE ROW LEVEL SECURITY;

-- migrate:down

ALTER TABLE provider_inbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE effect_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event NO FORCE ROW LEVEL SECURITY;

ALTER TABLE api_client ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_client_tenant_isolation ON api_client
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON tenant, api_client, api_client_scope FROM baas_app;
REVOKE ALL ON audit_event FROM baas_app;
REVOKE ALL ON idempotency_record, effect_outbox, provider_inbox FROM baas_app;
REVOKE USAGE ON SCHEMA public FROM baas_app;
DROP ROLE IF EXISTS baas_app;
