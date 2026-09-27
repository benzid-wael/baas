import type { CalendarDate } from "./calendar.js";
import type { CurrencyCode } from "./currency.js";
import type { Branded } from "./identifiers.js";
import type { Money } from "./money.js";
import type { Duration, Instant } from "./time.js";

/**
 * Ports the domain declares and infrastructure implements (RFC-BaaS §5.5).
 * Declared here, with no implementation, so that a use case can depend on the
 * seam without depending on the thing behind it.
 */

/**
 * The only sanctioned source of the current time.
 *
 * Review finding B4: 203 direct clock reads in the incumbent service made four
 * distinct expiry rules — a five-minute review, a ten-minute approval
 * proposal, ninety-second evidence freshness, an hourly provider check —
 * impossible to unit-test, and three separate expiry surprises cost time in a
 * single week.
 */
export interface Clock {
  now(): Instant;
}

/** A canonical UUID string. The generator decides the version; callers do not. */
export type Uuid = Branded<string, "Uuid">;

/**
 * The only sanctioned source of identifiers, so that tests are deterministic
 * and an id can be asserted rather than matched by shape.
 */
export interface IdGenerator {
  next(): Uuid;
}

/**
 * What a provider says an account is.
 *
 * Provider-neutral and read-only: this is what an adapter returns, and it is
 * mapped into stored state by a sync. Note there is a balance here and none on
 * the stored account — the provider is authoritative for how much money
 * exists, so a balance is something observed at a moment, never a property we
 * keep.
 */
export interface ProviderAccount {
  readonly accountReference: string;
  readonly ownerReference: string | null;
  readonly product: "current_account" | "wallet" | "savings";
  readonly currency: CurrencyCode;
  readonly status: "pending" | "active" | "frozen" | "closed" | "unknown";
  readonly iban: string | null;
  readonly accountNumber: string | null;
  readonly sortCode: string | null;
  readonly bic: string | null;
  readonly openedAt: Instant | null;
}

export interface ProviderBalance {
  readonly accountReference: string;
  readonly available: Money;
  readonly current: Money;
  readonly observedAt: Instant;
}

export interface ProviderTransaction {
  readonly transactionReference: string;
  readonly accountReference: string;
  readonly direction: "debit" | "credit";
  readonly amount: Money;
  readonly status: "pending" | "settled" | "rejected" | "reversed" | "unknown";
  readonly counterpartyName: string | null;
  readonly narrative: string | null;
  readonly occurredAt: Instant;
}

export interface TransactionPage {
  readonly transactions: readonly ProviderTransaction[];
  readonly nextCursor: string | undefined;
}

/**
 * Reads only. Writes go through the outbox and are dispatched by a worker,
 * so a read port cannot accidentally become a way to move money.
 */
export interface AccountReadPort {
  listAccounts(ownerReference: string): Promise<readonly ProviderAccount[]>;
  getAccount(accountReference: string): Promise<ProviderAccount | undefined>;
  getBalance(accountReference: string): Promise<ProviderBalance | undefined>;
}

export interface TransactionReadPort {
  listTransactions(request: {
    readonly accountReference: string;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<TransactionPage>;
}

/**
 * What a customer is told about a balance.
 *
 * A discriminated union rather than a nullable number, because the three
 * cases are genuinely different and a client must handle them differently:
 * a fresh figure, a figure we last saw some time ago, and no figure at all.
 *
 * Finding F4: the incumbent's portal rendered an empty charges array as blank
 * next to a confident total, which read as fee-free. A balance has the same
 * hazard in a sharper form — an absent balance rendered as `0.00` reads as
 * "you have no money", which is a worse lie than an error.
 */
export type BalanceView =
  | {
      readonly kind: "observed";
      readonly available: Money;
      readonly current: Money;
      readonly observedAt: Instant;
      /** How long ago. Present so a client can show it rather than guess. */
      readonly age: Duration;
      /** False when this came from storage because the provider was unreachable. */
      readonly fresh: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "never_observed" | "provider_unreachable";
    };

export interface ProviderStatement {
  readonly statementReference: string;
  readonly accountReference: string;
  /** A calendar range, not an instant range. See `CalendarDate`. */
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  /** False when the provider lists a period it cannot yet produce a file for. */
  readonly available: boolean;
}

export interface StatementReadPort {
  listStatements(request: {
    readonly ownerReference: string;
    readonly accountReference: string;
  }): Promise<readonly ProviderStatement[]>;
}
