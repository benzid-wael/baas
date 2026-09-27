import { Instant, Money, toCurrencyCode } from "@baas/domain";
import { fromJsDate, toJsDate } from "@baas/platform";
import type { ScopedDatabase } from "./tenant-scope.js";
import type { TransactionDirection, TransactionStatus } from "./schema.js";

export interface ProjectedTransaction {
  readonly providerId: string;
  readonly transactionReference: string;
  readonly accountId: string;
  readonly direction: TransactionDirection;
  readonly amount: Money;
  readonly status: TransactionStatus;
  readonly counterpartyName: string | null;
  readonly narrative: string | null;
  readonly occurredAt: Instant;
}

export interface TransactionPageRequest {
  readonly accountId: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface TransactionPageResult {
  readonly transactions: readonly ProjectedTransaction[];
  readonly nextCursor: string | undefined;
}

/**
 * A cursor is opaque by contract: clients pass back what they were given and
 * may not construct one. It encodes the keyset position — the instant and the
 * reference — because those two together are a total order and a page boundary
 * has to be exact.
 */
export function encodeCursor(occurredAt: Instant, reference: string): string {
  return Buffer.from(
    `${occurredAt.epochMilliseconds.toString()}:${reference}`,
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): { occurredAtMs: number; reference: string } | undefined {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const occurredAtMs = Number(decoded.slice(0, separator));
  if (!Number.isSafeInteger(occurredAtMs)) {
    return undefined;
  }
  return { occurredAtMs, reference: decoded.slice(separator + 1) };
}

export class InvalidCursorError extends Error {
  readonly code = "persistence.transaction.invalid_cursor";
  constructor() {
    // Deliberately says nothing about the encoding. A cursor is ours, and
    // explaining its shape invites clients to build one.
    super("The supplied cursor is not one this service issued");
    this.name = "InvalidCursorError";
  }
}

export class TransactionRepository {
  /**
   * Keyset pagination, never offset.
   *
   * An offset skips and repeats rows whenever the underlying set changes
   * between pages, and for a transaction list that is not cosmetic: a
   * customer scrolling while a payment settles would see a transaction twice
   * or not at all. The keyset is `(occurred_at, transaction_reference)`
   * descending, with the reference present to make the order total — two
   * transactions at the same instant must still have a stable order.
   */
  async page(
    db: ScopedDatabase,
    request: TransactionPageRequest,
  ): Promise<TransactionPageResult> {
    let query = db
      .selectFrom("transaction_projection")
      .selectAll()
      .where("account_id", "=", request.accountId)
      .orderBy("occurred_at", "desc")
      .orderBy("transaction_reference", "desc")
      // One extra row, to learn whether there is a next page without counting.
      .limit(request.limit + 1);

    if (request.cursor !== undefined) {
      const position = decodeCursor(request.cursor);
      if (position === undefined) {
        throw new InvalidCursorError();
      }
      const at = toJsDate(Instant.fromEpochMilliseconds(position.occurredAtMs));
      query = query.where((eb) =>
        eb.or([
          eb("occurred_at", "<", at),
          eb.and([
            eb("occurred_at", "=", at),
            eb("transaction_reference", "<", position.reference),
          ]),
        ]),
      );
    }

    const rows = await query.execute();
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);

    return {
      transactions: page.map(toProjected),
      nextCursor:
        rows.length > request.limit && last !== undefined
          ? encodeCursor(
              fromJsDate(last.occurred_at),
              last.transaction_reference,
            )
          : undefined,
    };
  }

  /**
   * Write the read model. Only callable inside `TenantScope.runAsProjector`.
   *
   * An upsert rather than an insert, because re-projecting the same
   * transaction must be a no-op rather than a conflict — that is what makes a
   * rebuild safe to run at any time.
   */
  async project(
    db: ScopedDatabase,
    tenantId: string,
    transactions: readonly ProjectedTransaction[],
  ): Promise<void> {
    if (transactions.length === 0) {
      return;
    }
    await db
      .insertInto("transaction_projection")
      .values(
        transactions.map((transaction) => ({
          provider_id: transaction.providerId,
          transaction_reference: transaction.transactionReference,
          tenant_id: tenantId,
          account_id: transaction.accountId,
          direction: transaction.direction,
          currency: transaction.amount.currency,
          amount_minor_units: transaction.amount.minorUnits.toString(),
          status: transaction.status,
          counterparty_name: transaction.counterpartyName,
          narrative: transaction.narrative,
          occurred_at: toJsDate(transaction.occurredAt),
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns(["provider_id", "transaction_reference"])
          .doUpdateSet((eb) => ({
            status: eb.ref("excluded.status"),
            counterparty_name: eb.ref("excluded.counterparty_name"),
            narrative: eb.ref("excluded.narrative"),
            occurred_at: eb.ref("excluded.occurred_at"),
            amount_minor_units: eb.ref("excluded.amount_minor_units"),
            direction: eb.ref("excluded.direction"),
          })),
      )
      .execute();
  }

  /** Discard the projection for one account, so it can be rebuilt. */
  async clearAccount(db: ScopedDatabase, accountId: string): Promise<void> {
    await db
      .deleteFrom("transaction_projection")
      .where("account_id", "=", accountId)
      .execute();
  }
}

function toProjected(row: {
  provider_id: string;
  transaction_reference: string;
  account_id: string;
  direction: TransactionDirection;
  currency: string;
  amount_minor_units: string;
  status: TransactionStatus;
  counterparty_name: string | null;
  narrative: string | null;
  occurred_at: Date;
}): ProjectedTransaction {
  const currency = toCurrencyCode(row.currency);
  return {
    providerId: row.provider_id,
    transactionReference: row.transaction_reference,
    accountId: row.account_id,
    direction: row.direction,
    amount: Money.fromMinorUnits(BigInt(row.amount_minor_units), currency),
    status: row.status,
    counterpartyName: row.counterparty_name,
    narrative: row.narrative,
    occurredAt: fromJsDate(row.occurred_at),
  };
}
