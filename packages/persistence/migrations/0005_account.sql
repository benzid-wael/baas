-- Account references and lifecycle (task M1-3).
--
-- **No balance column, deliberately.** The provider is authoritative for how
-- much money exists (RFC-BaaS §5.7). A stored balance is a cache that will be
-- wrong and will be believed.
--
-- The incumbent's `FintechAccount` carries availableBalance, currentBalance,
-- openingBalance, openingBalanceConfirmed, initialBalanceObservation and
-- balanceFetchedAt on the same object as the account's identity. Four of those
-- are observations with a time, not properties of an account. Observations are
-- modelled as observations in 0006; this table is what an account *is*.
--
-- Like provider links, an account is derived: the provider owns it, and we
-- learn about it. Writes are refused outside a provider sync.

-- migrate:up

CREATE TABLE account (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  customer_id        uuid NOT NULL REFERENCES customer (id),
  provider_id        text NOT NULL,
  account_reference  text NOT NULL,
  product            text NOT NULL
                       CHECK (product IN ('current_account', 'wallet', 'savings')),
  currency           text NOT NULL CHECK (char_length(currency) = 3),
  status             text NOT NULL
                       CHECK (status IN ('pending', 'active', 'frozen', 'closed', 'unknown')),
  status_reason      text,
  iban               text,
  account_number     text,
  sort_code          text,
  bic                text,
  opened_at          timestamptz,
  observed_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL
);

COMMENT ON TABLE account IS
  'classification: restricted. Derived from the provider; writable only under app.provider_sync. Holds no balance: the provider is authoritative for how much money exists.';
COMMENT ON COLUMN account.iban IS
  'classification: restricted. A bank identifier for a named person.';
COMMENT ON COLUMN account.account_number IS
  'classification: restricted. A bank identifier for a named person.';

CREATE UNIQUE INDEX account_provider_reference_idx
  ON account (provider_id, account_reference);
CREATE INDEX account_customer_idx ON account (tenant_id, customer_id);
CREATE UNIQUE INDEX account_iban_idx ON account (iban) WHERE iban IS NOT NULL;

CREATE FUNCTION account_is_derived() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.provider_sync', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'account is derived from provider observations: % is only permitted inside a provider sync', TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_derived
  BEFORE INSERT OR UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION account_is_derived();

ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;

CREATE POLICY account_tenant_isolation ON account
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON account TO baas_app;

-- migrate:down

DROP TRIGGER account_derived ON account;
DROP FUNCTION account_is_derived();
DROP TABLE account;
