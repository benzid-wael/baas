import { Duration, Instant } from "@baas/domain";
import type {
  Clock,
  IdGenerator,
  ProviderCall,
  ProviderCallRecorder,
} from "@baas/domain";
import { describeError, scrubText, toJsDate } from "@baas/platform";
import type { Logger } from "@baas/platform";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import type { ScopedDatabase, TenantScope } from "./tenant-scope.js";

/**
 * The shortest retention in the service, and the default is deliberately short
 * (MP-2). Diagnosing a provider failure is a matter of days; holding a bank's
 * verbatim answer for longer is holding personal data for no purpose.
 */
export const DEFAULT_RETENTION = Duration.ofDays(30);

/**
 * How much of a body is kept.
 *
 * A cap rather than no cap: a provider that returns a megabyte of HTML on a
 * gateway error will do it on every call during an incident, which is exactly
 * when this table is being written to hardest. Truncation is marked so nobody
 * reads a clipped body as a complete one.
 */
export const MAX_BODY = 16_384;
const TRUNCATED = "…[truncated]";

export interface RecordedCall {
  readonly id: string;
  readonly providerId: string;
  readonly operation: string;
  readonly correlationId: string | null;
  readonly idempotencyId: string | null;
  readonly outcome: string;
  readonly responseStatus: number | null;
  readonly requestBody: string;
  readonly responseBody: string;
  readonly errorMessage: string | null;
  readonly startedAt: Date;
  readonly durationMs: number;
}

export interface ProviderCallPage {
  readonly calls: readonly RecordedCall[];
  readonly nextCursor?: string;
}

export interface ProviderCallQuery {
  readonly limit: number;
  readonly providerId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly cursor?: string | undefined;
}

/**
 * Reading and purging the provider request log.
 *
 * Writing is a separate class — `TenantScopedCallRecorder` below — because the
 * write happens on the provider call path and the read happens in an operator
 * console. Sharing one object would put a `record` method within reach of the
 * controller and a paging query within reach of an adapter.
 */
export class ProviderRequestLogRepository {
  async page(
    db: ScopedDatabase,
    query: ProviderCallQuery,
  ): Promise<ProviderCallPage> {
    let statement = db
      .selectFrom("provider_request_log")
      .selectAll()
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .limit(query.limit + 1);

    if (query.providerId !== undefined) {
      statement = statement.where("provider_id", "=", query.providerId);
    }
    if (query.correlationId !== undefined) {
      statement = statement.where("correlation_id", "=", query.correlationId);
    }
    if (query.cursor !== undefined) {
      // Keyset, not offset: an offset page shifts under a table being written
      // to continuously, which this one is.
      const after = decodeCursor(query.cursor);
      statement = statement.where((eb) =>
        eb.or([
          eb("started_at", "<", after.startedAt),
          eb.and([
            eb("started_at", "=", after.startedAt),
            eb("id", "<", after.id),
          ]),
        ]),
      );
    }

    const rows = await statement.execute();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      calls: page.map(toRecordedCall),
      ...(rows.length > query.limit && last !== undefined
        ? { nextCursor: encodeCursor(last.started_at, last.id) }
        : {}),
    };
  }

  async byId(
    db: ScopedDatabase,
    id: string,
  ): Promise<RecordedCall | undefined> {
    const row = await db
      .selectFrom("provider_request_log")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecordedCall(row);
  }

  /**
   * Delete everything past its retention, **across every tenant**.
   *
   * Deliberately not tenant-scoped, and deliberately taking the raw connection
   * rather than a `ScopedDatabase`: retention is an obligation of the service,
   * not a feature of a tenant, and a purge that ran per tenant would skip a
   * tenant nobody remembered to enumerate.
   */
  async purgeExpired(
    db: Kysely<Database>,
    now: Instant,
    batchSize = 5_000,
  ): Promise<number> {
    const deleted = await db
      .deleteFrom("provider_request_log")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("provider_request_log")
          .select("id")
          .where("retention_until", "<", toJsDate(now))
          .limit(batchSize),
      )
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

export interface CallRecorderOptions {
  readonly scope: TenantScope;
  readonly tenantId: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly retention?: Duration;
}

/**
 * Writes a provider call to the log, and **never rejects** (MP-2).
 *
 * An adapter awaits this on the call path. A rejection here would turn a
 * logging failure into a failed payment, which inverts the point of the table
 * — so every error is caught, reported through the logger, and dropped.
 *
 * Bodies are scrubbed with the same named shapes as the log scrubber (New-8).
 * A provider's words are not safer for being in a table than in a log line,
 * and this table exists to be read by people.
 */
export class TenantScopedCallRecorder implements ProviderCallRecorder {
  constructor(private readonly options: CallRecorderOptions) {}

  async record(call: ProviderCall): Promise<void> {
    try {
      const retention = this.options.retention ?? DEFAULT_RETENTION;
      await this.options.scope.run(this.options.tenantId, (db) =>
        db
          .insertInto("provider_request_log")
          .values({
            id: this.options.ids.next(),
            tenant_id: this.options.tenantId,
            provider_id: call.providerId,
            operation: call.operation,
            correlation_id: call.correlationId ?? null,
            idempotency_id: call.idempotencyId ?? null,
            outcome: call.outcome,
            response_status: call.responseStatus ?? null,
            request_body: prepare(call.requestBody),
            response_body: prepare(call.responseBody),
            error_message:
              call.errorMessage === undefined
                ? null
                : scrubText(call.errorMessage),
            started_at: toJsDate(call.startedAt),
            duration_ms: call.durationMs,
            retention_until: toJsDate(call.startedAt.plus(retention)),
          })
          .execute(),
      );
    } catch (error) {
      this.options.logger.error(
        { providerId: call.providerId, err: describeError(error) },
        "could not record a provider call",
      );
    }
  }
}

/** Scrub first, then truncate: a body clipped before scrubbing is unscrubbed. */
function prepare(body: string): string {
  const scrubbed = scrubText(body);
  return scrubbed.length <= MAX_BODY
    ? scrubbed
    : `${scrubbed.slice(0, MAX_BODY)}${TRUNCATED}`;
}

function toRecordedCall(row: {
  id: string;
  provider_id: string;
  operation: string;
  correlation_id: string | null;
  idempotency_id: string | null;
  outcome: string;
  response_status: number | null;
  request_body: string;
  response_body: string;
  error_message: string | null;
  started_at: Date;
  duration_ms: number;
}): RecordedCall {
  return {
    id: row.id,
    providerId: row.provider_id,
    operation: row.operation,
    correlationId: row.correlation_id,
    idempotencyId: row.idempotency_id,
    outcome: row.outcome,
    responseStatus: row.response_status,
    requestBody: row.request_body,
    responseBody: row.response_body,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

/**
 * The cursor is ours and its shape is not a client's business, so it is opaque
 * — the same rule and the same encoding as the transaction projection. A
 * client that learns to build one has learned to page by a column we then
 * cannot change.
 *
 * Deliberately **not exported**: `transaction-repository.ts` already exports
 * `encodeCursor`/`decodeCursor`, and two functions of the same name re-exported
 * from one package index is a collision waiting to resolve the wrong way.
 */
function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(
    `${startedAt.getTime().toString()}:${id}`,
    "utf8",
  ).toString("base64url");
}

export class InvalidCallCursorError extends Error {
  readonly code = "persistence.provider_request_log.invalid_cursor";

  constructor() {
    // Says nothing about the encoding, for the same reason the transaction
    // cursor does not: explaining its shape invites clients to build one.
    super("The supplied cursor is not one this service issued");
    this.name = "InvalidCallCursorError";
  }
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const startedAtMs =
    separator <= 0 ? Number.NaN : Number(decoded.slice(0, separator));
  if (!Number.isSafeInteger(startedAtMs)) {
    throw new InvalidCallCursorError();
  }
  return {
    startedAt: toJsDate(Instant.fromEpochMilliseconds(startedAtMs)),
    id: decoded.slice(separator + 1),
  };
}
