import { z } from "zod";
import { CURRENCY_SCALES, Money, scaleOf } from "@baas/domain";
import type { CurrencyCode } from "@baas/domain";

/**
 * Wire primitives.
 *
 * `@baas/contracts` describes what goes over the wire. It depends on
 * `@baas/domain` — which depends on nothing — so that a rule like "a currency
 * has this many decimal places" has one home rather than two. It depends on
 * nothing else, so the generated client carries no framework and no
 * infrastructure.
 */

export const currencyCodeSchema = z.enum(
  Object.keys(CURRENCY_SCALES) as [CurrencyCode, ...CurrencyCode[]],
);

const CANONICAL_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Money on the wire is a decimal string at the currency's own scale, plus the
 * currency. Exactly `"11.00"` for AED; `"11"` and `"11.000"` are both refused.
 *
 * Two choices worth stating, because both were live options:
 *
 * - **A decimal string, not a number.** A JSON number is a double, and a
 *   double is not a permitted representation of money anywhere in this system.
 * - **Canonical, not merely parseable.** Requiring the exact scale means two
 *   equal amounts always have identical representations, so a client that
 *   compares the strings — and one will — gets the right answer. The
 *   incumbent's `"11.00"` versus `"11"` across a boundary cost an afternoon.
 */
export const moneySchema = z
  .object({
    amount: z.string().regex(CANONICAL_DECIMAL, "must be a decimal string"),
    currency: currencyCodeSchema,
  })
  .superRefine((value, ctx) => {
    const expected = scaleOf(value.currency);
    if (decimalPlaces(value.amount) !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message:
          `amount must carry exactly ${expected.toString()} decimal ` +
          `place${expected === 1 ? "" : "s"} for ${value.currency}`,
      });
    }
  });

export type MoneyWire = z.infer<typeof moneySchema>;

export function toMoney(wire: MoneyWire): Money {
  return Money.of(wire.amount, wire.currency);
}

export function fromMoney(money: Money): MoneyWire {
  return { amount: money.toDecimalString(), currency: money.currency };
}

function decimalPlaces(amount: string): number {
  const separator = amount.indexOf(".");
  return separator === -1 ? 0 : amount.length - separator - 1;
}

/**
 * An instant on the wire is ISO-8601 in UTC with milliseconds and an explicit
 * `Z`. One representation, so a client never has to decide whether a missing
 * offset means UTC or local.
 */
export const instantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be an ISO-8601 instant in UTC, e.g. 2026-09-26T12:00:00.000Z",
  );

export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUID",
  );

export const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/, "must be a lower-case slug")
  .max(64);

/**
 * Cursor pagination, not offset.
 *
 * Offsets skip and repeat rows whenever the underlying set changes between
 * pages, which for a transaction list is not a cosmetic problem. The cursor is
 * opaque by contract: clients pass back what they were given and may not
 * construct one.
 */
export const cursorSchema = z.string().min(1).max(4096);

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.optional(),
  });
}
