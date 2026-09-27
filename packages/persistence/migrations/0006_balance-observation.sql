-- Balance observations (task M1-5).
--
-- A balance is not a property of an account; it is something a provider said
-- at a moment. Storing it as an observation with a time is what makes it
-- auditable — "why did we show 1,234.50" has an answer — and is why the
-- account table has no balance column.
--
-- Minor units as BIGINT, never a float and never NUMERIC-read-as-double. `pg`
-- returns BIGINT as a string, which is exactly what `Money` wants.

-- migrate:up

CREATE TABLE balance_observation (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  account_id            uuid NOT NULL REFERENCES account (id),
  currency              text NOT NULL CHECK (char_length(currency) = 3),
  available_minor_units bigint NOT NULL,
  current_minor_units   bigint NOT NULL,
  source                text NOT NULL CHECK (source IN ('provider_read', 'reconciled')),
  observed_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL
);

COMMENT ON TABLE balance_observation IS
  'classification: restricted. What a provider said a balance was, and when. Append-only; the latest row is not the truth, it is the most recent evidence.';
COMMENT ON COLUMN balance_observation.available_minor_units IS
  'Minor units. Never a float: an amount that has been through a double is already wrong.';

-- The read is always "the newest observation for this account".
CREATE INDEX balance_observation_latest_idx
  ON balance_observation (account_id, observed_at DESC);

-- Observations are evidence. Evidence is not edited.
CREATE FUNCTION balance_observation_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'balance_observation is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER balance_observation_no_update
  BEFORE UPDATE OR DELETE ON balance_observation
  FOR EACH ROW EXECUTE FUNCTION balance_observation_is_append_only();

ALTER TABLE balance_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_observation FORCE ROW LEVEL SECURITY;

CREATE POLICY balance_observation_tenant_isolation ON balance_observation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON balance_observation TO baas_app;

-- migrate:down

DROP TRIGGER balance_observation_no_update ON balance_observation;
DROP FUNCTION balance_observation_is_append_only();
DROP TABLE balance_observation;
