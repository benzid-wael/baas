-- The provider request log (task MP-2, finding C4).
--
-- Finding C4 says this plainly: the incumbent's `keel_request_log` "was the
-- only reason several failures were explicable. It is excellent and should be
-- treated as a first-class product surface, with retention and an operator
-- view, not an implementation detail." So it arrives with both.
--
-- It is also the **most dangerous table in the service**. It holds provider
-- request and response bodies verbatim, which is where names, addresses, IBANs
-- and identity-document references live. Three consequences, all enforced
-- here rather than by convention:
--
--   1. **The strictest retention class.** Every row carries the time it must
--      be gone by, computed at insert. A purge job on the ordinary scheduler
--      deletes them — written *and scheduled*, because finding N2 is a
--      retention routine that exists and never runs.
--   2. **Bodies are scrubbed on the way in**, by the same named shapes as the
--      log scrubber (New-8). A provider's words are not safer for being in a
--      table than in a log line.
--   3. **Reads are audited**, like every other operator read of customer data.
--
-- The table is deliberately append-only for the application: a row may be
-- inserted and deleted by the purge, never updated. A request log somebody can
-- edit is not evidence.

-- migrate:up

CREATE TABLE provider_request_log (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  provider_id      text NOT NULL,
  -- "POST /api/baas/v2/payments". The path, never the query string: query
  -- parameters carry account references and customer ids.
  operation        text NOT NULL,
  correlation_id   text,
  idempotency_id   text,
  -- Monotonic in the sense that matters: what we know about the call.
  --   ok          the provider answered, and answered successfully
  --   rejected    the provider answered, and refused
  --   unreachable we never got an answer, and do not know whether it acted
  outcome          text NOT NULL
                     CHECK (outcome IN ('ok', 'rejected', 'unreachable')),
  response_status  integer,
  request_body     text NOT NULL,
  response_body    text NOT NULL,
  error_message    text,
  started_at       timestamptz NOT NULL,
  duration_ms      integer NOT NULL CHECK (duration_ms >= 0),
  -- Computed at insert from the configured retention. A row past this is
  -- deleted by the scheduled purge; nothing reads it first.
  retention_until  timestamptz NOT NULL
);

COMMENT ON TABLE provider_request_log IS
  'classification: restricted, shortest retention in the service. Provider request and response bodies, scrubbed on write. Reads are audited.';
COMMENT ON COLUMN provider_request_log.request_body IS
  'classification: restricted. Scrubbed of named personal-data shapes on write, which is a reduction of risk and not an elimination of it.';
COMMENT ON COLUMN provider_request_log.response_body IS
  'classification: restricted. As above.';
COMMENT ON COLUMN provider_request_log.operation IS
  'Method and path. Never the query string: query parameters carry account references.';

-- The operator view reads newest-first within a tenant, usually narrowed to
-- one provider or one correlation id.
CREATE INDEX provider_request_log_recent_idx
  ON provider_request_log (tenant_id, started_at DESC, id DESC);
CREATE INDEX provider_request_log_correlation_idx
  ON provider_request_log (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
-- The purge scans by expiry alone and must not read the whole table to do it.
CREATE INDEX provider_request_log_retention_idx
  ON provider_request_log (retention_until);

ALTER TABLE provider_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_request_log FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_request_log_tenant_isolation ON provider_request_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE grant. A request log somebody can edit is not evidence, and the
-- absence of the grant says so more durably than a comment.
GRANT SELECT, INSERT, DELETE ON provider_request_log TO baas_app;

-- migrate:down

DROP TABLE provider_request_log;
