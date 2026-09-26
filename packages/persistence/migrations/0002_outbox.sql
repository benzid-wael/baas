-- Idempotency, outbox and inbox (RFC-BaaS §5.6, §5.10 · tasks T10, T11).
--
-- The property that matters: the outbox row is written in the same
-- transaction as the domain change that justifies it, and survives any
-- outcome, including none. Finding A7 -- a provider 202 with no webhook
-- degrading to a two-operator review queue -- stops being the default.

-- migrate:up

-- One idempotency primitive for every command path (finding A6). The
-- incumbent has five, with different replay semantics, so an operator has to
-- learn each one.
CREATE TABLE idempotency_record (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  scope                text NOT NULL,
  idempotency_key      text NOT NULL,
  request_fingerprint  text NOT NULL,
  state                text NOT NULL CHECK (state IN ('in_flight', 'completed')),
  result               jsonb,
  created_at           timestamptz NOT NULL,
  completed_at         timestamptz
);

CREATE UNIQUE INDEX idempotency_record_key_idx
  ON idempotency_record (tenant_id, scope, idempotency_key);

COMMENT ON COLUMN idempotency_record.request_fingerprint IS
  'A reused key with a different fingerprint is refused, not replayed.';

-- Every outbound effect. The id is the provider idempotency key, so a retry
-- is definitionally the same operation.
CREATE TABLE effect_outbox (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  provider_id      text NOT NULL,
  operation        text NOT NULL,
  payload          jsonb NOT NULL,
  state            text NOT NULL
                     CHECK (state IN ('pending', 'dispatched', 'confirmed', 'failed', 'unknown')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  lease_until      timestamptz,
  leased_by        text,
  provider_ref     text,
  last_error       text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

-- The claim query's index: due, unleased, in a claimable state.
CREATE INDEX effect_outbox_claimable_idx
  ON effect_outbox (next_attempt_at)
  WHERE state IN ('pending', 'unknown');

CREATE INDEX effect_outbox_aggregate_idx ON effect_outbox (aggregate_type, aggregate_id);
CREATE INDEX effect_outbox_lease_idx ON effect_outbox (lease_until) WHERE lease_until IS NOT NULL;

-- Every webhook and every poll response, verbatim, recorded before anything
-- is decided from it. Finding C2: keel_webhook_event has never contained a
-- row in development.
CREATE TABLE provider_inbox (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant (id),
  provider_id         text NOT NULL,
  external_event_id   text,
  event_type          text,
  provider_ref        text,
  signature_verified  boolean NOT NULL,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL,
  processed_at        timestamptz,
  process_error       text
);

COMMENT ON TABLE provider_inbox IS
  'classification: restricted. Holds raw provider bodies and therefore PII; inherits the strictest retention in the service.';

-- A provider that supplies an event id gets exactly-once ingestion for free.
CREATE UNIQUE INDEX provider_inbox_external_idx
  ON provider_inbox (provider_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE INDEX provider_inbox_unprocessed_idx
  ON provider_inbox (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX provider_inbox_ref_idx ON provider_inbox (provider_id, provider_ref);

ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_record_tenant_isolation ON idempotency_record
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY effect_outbox_tenant_isolation ON effect_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY provider_inbox_tenant_isolation ON provider_inbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- migrate:down

DROP TABLE provider_inbox;
DROP TABLE effect_outbox;
DROP TABLE idempotency_record;
