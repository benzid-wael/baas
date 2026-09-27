-- The transaction read model (task M1-6).
--
-- **One writer.** Finding A7: the incumbent's settlement state is written by
-- several services, so no single place can be read to know what happened. A
-- trigger refuses any write outside `app.projector`, which makes the rule
-- structural rather than conventional.
--
-- **No surrogate key.** The primary key is (provider_id,
-- transaction_reference), which is what a transaction actually is. A generated
-- id would change on every rebuild, and a projection whose rebuild produces
-- different rows cannot be verified against the one it replaced.
--
-- **Nothing here records when we projected it.** Same reason: a projected_at
-- column would differ between a rebuild and the original, so the rows would
-- no longer be comparable. Every column is determined by what the provider
-- said.

-- migrate:up

CREATE TABLE transaction_projection (
  provider_id            text NOT NULL,
  transaction_reference  text NOT NULL,
  tenant_id              uuid NOT NULL REFERENCES tenant (id),
  account_id             uuid NOT NULL REFERENCES account (id),
  direction              text NOT NULL CHECK (direction IN ('debit', 'credit')),
  currency               text NOT NULL CHECK (char_length(currency) = 3),
  amount_minor_units     bigint NOT NULL,
  status                 text NOT NULL
                           CHECK (status IN ('pending', 'settled', 'rejected', 'reversed', 'unknown')),
  counterparty_name      text,
  narrative              text,
  occurred_at            timestamptz NOT NULL,
  PRIMARY KEY (provider_id, transaction_reference)
);

COMMENT ON TABLE transaction_projection IS
  'classification: restricted. Derived read model with exactly one writer. Rebuildable: drop it and re-project, and the rows are identical.';
COMMENT ON COLUMN transaction_projection.counterparty_name IS
  'classification: restricted. Names a third party to the customer.';

-- The paging index. Keyset, newest first, with the reference breaking ties so
-- the order is total — two transactions at the same instant must still have a
-- stable order or paging skips and repeats.
CREATE INDEX transaction_projection_page_idx
  ON transaction_projection (account_id, occurred_at DESC, transaction_reference DESC);

CREATE FUNCTION transaction_projection_single_writer() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.projector', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'transaction_projection has one writer: % is only permitted inside the projector', TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transaction_projection_writer
  BEFORE INSERT OR UPDATE OR DELETE ON transaction_projection
  FOR EACH ROW EXECUTE FUNCTION transaction_projection_single_writer();

ALTER TABLE transaction_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_projection FORCE ROW LEVEL SECURITY;

CREATE POLICY transaction_projection_tenant_isolation ON transaction_projection
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_projection TO baas_app;

-- migrate:down

DROP TRIGGER transaction_projection_writer ON transaction_projection;
DROP FUNCTION transaction_projection_single_writer();
DROP TABLE transaction_projection;
