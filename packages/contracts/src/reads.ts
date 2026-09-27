import { z } from "zod";
import {
  instantSchema,
  moneySchema,
  pageOf,
  slugSchema,
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

export type AccountWire = z.infer<typeof accountSchema>;
export type BalanceWire = z.infer<typeof balanceSchema>;
export type TransactionWire = z.infer<typeof transactionSchema>;
export type StatementWire = z.infer<typeof statementSchema>;
