import { z } from "zod";
import {
  instantSchema,
  moneySchema,
  pageOf,
  scopeSchema,
  slugSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * The read surface (M1-7).
 *
 * This is the **corrected** contract, not a copy of the incumbent's. Three
 * differences, each deliberate:
 *
 * - Money is `{amount, currency}` canonical at the currency's scale, rather
 *   than a bare string beside a separate `currencyCode`.
 * - Accounts and pending opening requests are separate resources, rather than
 *   two arrays in one response.
 * - There is no `providerErrors` array. A provider's failure is not something
 *   a customer is shown; it is a state of the field that failed.
 *
 * The BFF translates this into the shape mobile expects during cutover, and
 * that translation is deleted when mobile adopts the generated client
 * (New-11).
 */

export const accountStatusSchema = z.enum([
  "pending",
  "active",
  "frozen",
  "closed",
  "unknown",
]);

export const accountProductSchema = z.enum([
  "current_account",
  "wallet",
  "savings",
]);

/**
 * A balance is one of three things, and a client must handle them
 * differently: a fresh figure, a figure we last saw some time ago, or none.
 *
 * A discriminated union rather than a nullable amount, because the incumbent's
 * shape cannot express "stale" at all — and rendering an absent balance as
 * `0.00` reads as "you have no money", which is a worse lie than an error
 * (finding F4).
 */
export const balanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("observed"),
    available: moneySchema,
    current: moneySchema,
    observedAt: instantSchema,
    /** Seconds since the observation, so a client shows it rather than guessing. */
    ageSeconds: z.number().int().nonnegative(),
    /** False when this came from storage because the provider was unreachable. */
    fresh: z.boolean(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["never_observed", "provider_unreachable"]),
  }),
]);

export const accountSchema = z.object({
  accountReference: z.string().min(1),
  providerId: slugSchema,
  product: accountProductSchema,
  currency: z.string().length(3),
  status: accountStatusSchema,
  statusReason: z.string().nullable(),
  iban: z.string().nullable(),
  accountNumber: z.string().nullable(),
  sortCode: z.string().nullable(),
  bic: z.string().nullable(),
  openedAt: instantSchema.nullable(),
  balance: balanceSchema,
});

export const accountListSchema = z.object({
  accounts: z.array(accountSchema),
});

export const transactionDirectionSchema = z.enum(["debit", "credit"]);

export const transactionStatusSchema = z.enum([
  "pending",
  "settled",
  "rejected",
  "reversed",
  "unknown",
]);

export const transactionSchema = z.object({
  transactionReference: z.string().min(1),
  accountReference: z.string().min(1),
  direction: transactionDirectionSchema,
  amount: moneySchema,
  status: transactionStatusSchema,
  counterpartyName: z.string().nullable(),
  narrative: z.string().nullable(),
  occurredAt: instantSchema,
});

export const transactionPageSchema = pageOf(transactionSchema);

/**
 * A statement period is a calendar range, not an instant range. A boundary
 * computed in UTC moves a UAE customer's transaction between months, which is
 * why these are dates and why `CalendarDate` exists (New-7).
 */
export const statementSchema = z.object({
  statementReference: z.string().min(1),
  accountReference: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  available: z.boolean(),
});

export const statementListSchema = z.object({
  statements: z.array(statementSchema),
});

/**
 * What the operator surface says about a customer (MP-7b).
 *
 * Registered with a schema, unlike the first version of these paths, which
 * published a description and nothing else. The portal then declared its own
 * shape, got a field name wrong, and type-checked perfectly — the mismatch
 * turned up in a `curl`. A published path with no response schema is a path
 * whose consumers each invent a type (correction C16).
 */
export const customerSummarySchema = z.object({
  customerId: uuidSchema,
  externalUserUuid: uuidSchema,
  providers: z.array(
    z.object({
      providerId: slugSchema,
      status: z.string().min(1),
      statusReason: z.string().nullable(),
      observedAt: instantSchema,
    }),
  ),
});

export type CustomerSummaryWire = z.infer<typeof customerSummarySchema>;

export type AccountWire = z.infer<typeof accountSchema>;
export type BalanceWire = z.infer<typeof balanceSchema>;
export type TransactionWire = z.infer<typeof transactionSchema>;
export type StatementWire = z.infer<typeof statementSchema>;

/**
 * The provider request log, as an operator sees it (MP-2, New-27).
 *
 * The summary carries **no bodies**. They are the reason this is the most
 * sensitive table in the service, and a list view puts fifty of them on one
 * screen for a question the status and duration usually answer. Fetching one
 * is a second, separately audited act, and only that response carries them —
 * which is why these are two schemas rather than one with optional fields.
 */
export const providerCallSummarySchema = z.object({
  id: uuidSchema,
  providerId: slugSchema,
  /** Method and route. Never a concrete identifier; see correction C12. */
  operation: z.string().min(1),
  correlationId: z.string().nullable(),
  idempotencyId: z.string().nullable(),
  outcome: z.enum(["ok", "rejected", "unreachable"]),
  responseStatus: z.number().int().nullable(),
  startedAt: instantSchema,
  durationMs: z.number().int().nonnegative(),
});

export const providerCallPageSchema = pageOf(providerCallSummarySchema);

export const providerCallSchema = providerCallSummarySchema.extend({
  /** Scrubbed on write, and truncated past a cap. Still restricted data. */
  requestBody: z.string(),
  responseBody: z.string(),
  errorMessage: z.string().nullable(),
});

/** What the service can tell an operator about itself (MP-5, New-27). */
export const systemStateSchema = z.object({
  migrations: z.object({
    applied: z.array(z.string().min(1)),
    lastAppliedAt: instantSchema.optional(),
  }),
  schema: z.object({
    matches: z.boolean(),
    undeclared: z.array(z.string()),
    missing: z.array(z.string()),
  }),
  outbox: z.object({
    depths: z.array(
      z.object({
        state: z.string().min(1),
        count: z.number().int().nonnegative(),
        oldestAgeSeconds: z.number().int().nonnegative().optional(),
      }),
    ),
    /** `pending` + `dispatched` + `unknown`: everything undecided (A7). */
    unresolved: z.number().int().nonnegative(),
  }),
  inbox: z.object({
    unprocessed: z.number().int().nonnegative(),
    oldestUnprocessedAgeSeconds: z.number().int().nonnegative().optional(),
    rejectedSignatures: z.number().int().nonnegative(),
  }),
});

export type ProviderCallSummaryWire = z.infer<typeof providerCallSummarySchema>;
export type ProviderCallPageWire = z.infer<typeof providerCallPageSchema>;
export type ProviderCallWire = z.infer<typeof providerCallSchema>;
export type SystemStateWire = z.infer<typeof systemStateSchema>;

/**
 * An API client and its scopes, for the operator console (MP-3).
 *
 * The **history** is the surface, not the current state. Finding D2: the
 * incumbent's `PATCH` replaces the scope array wholesale with no audit row, so
 * "who granted this, and when" has no answer. Here every grant and every
 * revocation is a row that stays, and the console shows them.
 */
export const scopeGrantSchema = z.object({
  id: uuidSchema,
  scope: z.string().min(1),
  grantedAt: instantSchema,
  grantedBy: uuidSchema.nullable(),
  revokedAt: instantSchema.nullable(),
  revokedBy: uuidSchema.nullable(),
  reason: z.string().min(1),
  /** Derived, so a client never has to work out what `revokedAt: null` means. */
  live: z.boolean(),
});

export const apiClientSchema = z.object({
  id: uuidSchema,
  clientId: z.string().min(1),
  name: z.string().min(1),
  disabled: z.boolean(),
  createdAt: instantSchema,
  liveScopes: z.array(z.string().min(1)),
});

export const apiClientListSchema = z.object({
  clients: z.array(apiClientSchema),
});

export const scopeHistorySchema = z.object({
  /** Every grant this client has ever had, newest first. Nothing is removed. */
  grants: z.array(scopeGrantSchema),
});

export type ScopeGrantWire = z.infer<typeof scopeGrantSchema>;
export type ApiClientWire = z.infer<typeof apiClientSchema>;
export type ApiClientListWire = z.infer<typeof apiClientListSchema>;
export type ScopeHistoryWire = z.infer<typeof scopeHistorySchema>;

/** The answer to a grant: the scope that was granted, echoed back. */
export const grantedScopeSchema = z.object({ granted: scopeSchema });

/**
 * The answer to a revocation.
 *
 * `false` means the client did not hold that scope — not an error, because a
 * revocation of something already gone is a no-op and saying so is more useful
 * than a 404 that reads as "no such client".
 */
export const revokedScopeSchema = z.object({ revoked: z.boolean() });

export type GrantedScopeWire = z.infer<typeof grantedScopeSchema>;
export type RevokedScopeWire = z.infer<typeof revokedScopeSchema>;
