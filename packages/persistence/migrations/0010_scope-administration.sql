-- Administering an API client's scopes (task MP-3).
--
-- `baas_app` holds SELECT and nothing else on `api_client_scope`, decided in
-- 0003: the read path reads the registry in order to discover which tenant a
-- request belongs to, and that is all it should ever be able to do. Granting
-- it INSERT and UPDATE so an operator can edit scopes would also hand that
-- power to every mobile request, which shares the role.
--
-- So this follows the pattern 0005 and 0007 already established for derived
-- state: the grant exists, and a trigger refuses the write unless the one code
-- path allowed to make it has said so. `TenantScope.runAsScopeAdmin` is that
-- path, and it is named so the exception reads as deliberate at the call site.
--
-- Note what is NOT guarded: a revocation stamps `revoked_at` on the live row
-- and a re-grant inserts a new one, so the history is complete by
-- construction. There is deliberately still **no DELETE grant** — a grant that
-- can be deleted is a grant that was never evidence.

-- migrate:up

CREATE FUNCTION api_client_scope_requires_admin() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.scope_admin', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'api_client_scope may only be written inside runAsScopeAdmin (% attempted)',
      TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_client_scope_admin_only
  BEFORE INSERT OR UPDATE ON api_client_scope
  FOR EACH ROW EXECUTE FUNCTION api_client_scope_requires_admin();

GRANT INSERT, UPDATE ON api_client_scope TO baas_app;

-- migrate:down

REVOKE INSERT, UPDATE ON api_client_scope FROM baas_app;
DROP TRIGGER api_client_scope_admin_only ON api_client_scope;
DROP FUNCTION api_client_scope_requires_admin();
