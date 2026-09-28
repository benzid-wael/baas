-- Tracing a provider call to an account (task MP-9).
--
-- The log could already be filtered by provider and by correlation id. Neither
-- is how an incident actually starts: it starts with "this customer says their
-- balance is wrong", and the only identifier anybody has is an account
-- reference.
--
-- Note what this is **not** a reversal of. Correction C12 took identifiers out
-- of `operation`, because that column is a route shown fifty rows at a time and
-- an account reference there was an identifier on screen for a question nobody
-- asked. This column exists so the identifier can be *searched for* by someone
-- who already has it. Same data, opposite purpose.
--
-- Nullable, because plenty of provider calls are not about one account — a
-- token fetch, an account list for an owner.

-- migrate:up

ALTER TABLE provider_request_log ADD COLUMN account_reference text;

COMMENT ON COLUMN provider_request_log.account_reference IS
  'classification: restricted. The account a call was about, when it was about one. Indexed so an incident can be traced from the only identifier support usually has.';

CREATE INDEX provider_request_log_account_idx
  ON provider_request_log (tenant_id, account_reference, started_at DESC)
  WHERE account_reference IS NOT NULL;

-- migrate:down

DROP INDEX provider_request_log_account_idx;
ALTER TABLE provider_request_log DROP COLUMN account_reference;
