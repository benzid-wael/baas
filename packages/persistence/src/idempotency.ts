import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { Database } from "./schema.js";

/**
 * One idempotency primitive (RFC-BaaS §5.10, finding A6).
 *
 * The incumbent implements this five times — `PaymentExecutionService`,
 * `keel_customer_operation`, beneficiary `creationKeyHash`, payment-order
 * `idempotencyKey` and the BFF E2E module — with different replay semantics
 * each, so an operator has to learn which one they are looking at.
 *
 * Three behaviours, and the third is the one that matters:
 *
 *   first call     the operation runs and its result is stored
 *   repeat call    the stored result is replayed; the operation does not run
 *   reused key,
 *   different body **refused** under a stable code, never silently replayed
 *
 * The last is a correctness control, not a convenience. Replaying a stored
 * result for a *different* request would answer a payment of one amount with
 * the outcome of another.
 */
export interface IdempotencyOptions {
  readonly tenantId: string;
  readonly scope: string;
  readonly key: string;
  readonly request: unknown;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency.key_reused_with_different_request";

  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super(
      `Idempotency key ${JSON.stringify(key)} in scope ${JSON.stringify(scope)} was already used for a different request`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInFlightError extends Error {
  readonly code = "idempotency.in_flight";

  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super(
      `Idempotency key ${JSON.stringify(key)} in scope ${JSON.stringify(scope)} is already in flight`,
    );
    this.name = "IdempotencyInFlightError";
  }
}

export function fingerprint(request: unknown): string {
  return createHash("sha256").update(canonicalize(request)).digest("hex");
}

/** Stable across key order, so a reordered JSON body is the same request. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // JSON.stringify is typed as returning string, but genuinely returns
    // undefined for undefined, a function or a symbol.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

export class IdempotencyStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute<T>(
    options: IdempotencyOptions,
    operation: () => Promise<T>,
  ): Promise<T> {
    const print = fingerprint(options.request);
    const now = toJsDate(this.clock.now());

    // Claim the key. `ON CONFLICT DO NOTHING` makes the claim atomic, so two
    // concurrent callers cannot both believe they are first.
    const claimed = await this.db
      .insertInto("idempotency_record")
      .values({
        id: this.ids.next(),
        tenant_id: options.tenantId,
        scope: options.scope,
        idempotency_key: options.key,
        request_fingerprint: print,
        state: "in_flight",
        result: null,
        created_at: now,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();

    if ((claimed.numInsertedOrUpdatedRows ?? 0n) > 0n) {
      const result = await operation();
      await this.db
        .updateTable("idempotency_record")
        .set({
          state: "completed",
          // An operation returning undefined stores JSON null, not an
          // absent column, so a replay is distinguishable from a missing record.
          result: (JSON.stringify(result) as string | undefined) ?? "null",
          completed_at: toJsDate(this.clock.now()),
        })
        .where("tenant_id", "=", options.tenantId)
        .where("scope", "=", options.scope)
        .where("idempotency_key", "=", options.key)
        .execute();
      return result;
    }

    const existing = await this.db
      .selectFrom("idempotency_record")
      .selectAll()
      .where("tenant_id", "=", options.tenantId)
      .where("scope", "=", options.scope)
      .where("idempotency_key", "=", options.key)
      .executeTakeFirstOrThrow();

    if (existing.request_fingerprint !== print) {
      throw new IdempotencyConflictError(options.scope, options.key);
    }
    if (existing.state === "in_flight") {
      // Deliberately not "wait and retry": the caller decides whether to poll.
      // A blocking wait here would hold an HTTP request open behind a provider
      // call that may take minutes or never finish.
      throw new IdempotencyInFlightError(options.scope, options.key);
    }
    return existing.result as T;
  }
}
