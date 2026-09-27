-- Customer registry and provider links (task M1-2).
--
-- The mobile end user lives here, keyed by the uuid the BFF forwards -- not on
-- a `users` table, which is login-only. Getting that backwards is the Model B
-- correction the incumbent had to make.
--
-- Deliberately minimal. No name, no contact details, no documents: the read
-- milestone needs an identity and a set of provider links, and nothing else.
-- KYC evidence arrives with M2 under its own classification and encryption.
-- M1 must not become the task that quietly copies the customer table across.

-- migrate:up

CREATE TABLE customer (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant (id),
  external_user_uuid  uuid NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

COMMENT ON TABLE customer IS
  'classification: restricted. Pseudonymous identity only; no direct personal data.';
COMMENT ON COLUMN customer.external_user_uuid IS
  'classification: restricted. The end user as the BFF knows them. Pseudonymous, but re-identifiable by the BFF, so it is not free of personal data.';

CREATE UNIQUE INDEX customer_external_idx ON customer (tenant_id, external_user_uuid);

-- Every column here is **derived** from what a provider told us. Finding D4:
-- in the incumbent, editing provider link status directly appears to work and
-- is silently reverted on the next sync, which is worse than being refused.
CREATE TABLE provider_customer_link (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  customer_id           uuid NOT NULL REFERENCES customer (id),
  provider_id           text NOT NULL,
  external_customer_id  text NOT NULL,
  status                text NOT NULL
                          CHECK (status IN ('pending', 'active', 'blocked', 'offboarded', 'unknown')),
  status_reason         text,
  observed_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL
);

COMMENT ON TABLE provider_customer_link IS
  'classification: restricted. Derived state: writable only under app.provider_sync, never through an API.';

CREATE UNIQUE INDEX provider_customer_link_customer_idx
  ON provider_customer_link (tenant_id, provider_id, customer_id);
CREATE UNIQUE INDEX provider_customer_link_external_idx
  ON provider_customer_link (provider_id, external_customer_id);
CREATE INDEX provider_customer_link_lookup_idx
  ON provider_customer_link (customer_id);

-- Derived state is protected, not merely documented. A write must declare
-- itself as a provider sync, transaction-locally, which means an ordinary
-- request path cannot perform one however it is written.
CREATE FUNCTION provider_customer_link_is_derived() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.provider_sync', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'provider_customer_link is derived from provider observations: % is only permitted inside a provider sync', TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_customer_link_derived
  BEFORE INSERT OR UPDATE OR DELETE ON provider_customer_link
  FOR EACH ROW EXECUTE FUNCTION provider_customer_link_is_derived();

ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_customer_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_customer_link FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_tenant_isolation ON customer
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY provider_customer_link_tenant_isolation ON provider_customer_link
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON customer TO baas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_customer_link TO baas_app;

-- migrate:down

DROP TRIGGER provider_customer_link_derived ON provider_customer_link;
DROP FUNCTION provider_customer_link_is_derived();
DROP TABLE provider_customer_link;
DROP TABLE customer;
