import { UnknownCurrencyError } from "./errors.js";

/**
 * ISO 4217 minor-unit scale per currency.
 *
 * Scale is data, not an assumption. The classic defect is assuming two
 * everywhere: JPY has none and the Gulf three, so a two-decimal assumption
 * under- or over-states by a factor of 100 or 10 respectively. JPY and KWD are
 * in the table and in the test set even though neither is in the MVP corridor
 * list, precisely because they are the cases that break a lazy implementation.
 */
export const CURRENCY_SCALES = {
  AED: 2,
  BHD: 3,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  JOD: 3,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  PHP: 2,
  PKR: 2,
  SAR: 2,
  TND: 3,
  USD: 2,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof CURRENCY_SCALES;

/**
 * Read through a Map rather than by index. A `CurrencyCode` arriving from a
 * cast at a boundary may not be one, so the lookup must be genuinely
 * fallible — indexing a const record would make the guard look dead to the
 * type checker while still being the only thing catching a lie.
 */
const SCALES: ReadonlyMap<string, number> = new Map(
  Object.entries(CURRENCY_SCALES),
);

export function isCurrencyCode(value: string): value is CurrencyCode {
  return SCALES.has(value);
}

/** Throws rather than defaulting: an unknown currency is never "probably two". */
export function scaleOf(currency: CurrencyCode): number {
  const scale = SCALES.get(currency);
  if (scale === undefined) {
    throw new UnknownCurrencyError(currency);
  }
  return scale;
}

/** Parse an untrusted string into a `CurrencyCode`, or throw. */
export function toCurrencyCode(value: string): CurrencyCode {
  const upper = value.toUpperCase();
  if (!isCurrencyCode(upper)) {
    throw new UnknownCurrencyError(value);
  }
  return upper;
}
