import type { CurrencyCode } from "./currency.js";
import { scaleOf } from "./currency.js";
import {
  AmountPrecisionError,
  CurrencyMismatchError,
  InvalidAmountError,
} from "./errors.js";

/** Optional sign, whole part, optional fractional part. No exponent, no space. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Render signed minor units at an arbitrary scale. Pure, no `Number`. */
function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export interface MoneyJson {
  readonly minorUnits: string;
  readonly currency: CurrencyCode;
}

/**
 * An exact monetary amount. Never a float, never a bare string.
 *
 * Three rules, from RFC-BaaS §5.8, each answering review finding A5:
 *   1. Arithmetic only between identical currencies.
 *   2. Comparison only on minor units — never on formatted strings. Comparing
 *      "11.00" with "11" across a boundary produced a false diagnosis.
 *   3. Provider decimal formatting happens at the adapter boundary and nowhere
 *      else, via `toProviderDecimal`.
 *
 * There is no public constructor and no `number` anywhere in the type.
 */
export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  /**
   * Parse a decimal string. The parse goes straight to `bigint` — the string
   * never passes through `Number`, so `0.1 + 0.2` cannot happen here.
   *
   * More precision than the currency permits is an error, not a rounding
   * decision. Rounding is a business rule and does not belong in a parser.
   */
  static of(amount: string, currency: CurrencyCode): Money {
    const scale = scaleOf(currency);
    const match = DECIMAL.exec(amount);
    if (match === null) {
      throw new InvalidAmountError(amount, currency);
    }
    const sign = match[1] ?? "";
    const whole = match[2] ?? "";
    const fraction = match[3] ?? "";
    if (fraction.length > scale) {
      throw new AmountPrecisionError(amount, currency, scale);
    }
    const units = BigInt(whole + fraction.padEnd(scale, "0"));
    return new Money(sign === "-" ? -units : units, currency);
  }

  static fromMinorUnits(minorUnits: bigint, currency: CurrencyCode): Money {
    scaleOf(currency);
    return new Money(minorUnits, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  static fromJson(json: MoneyJson): Money {
    return Money.fromMinorUnits(BigInt(json.minorUnits), json.currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negated(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  absolute(): Money {
    return this.minorUnits < 0n ? this.negated() : this;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  /** Equality includes currency: 0 AED is not 0 USD. */
  isSameAs(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  /** The canonical decimal string at the currency's own scale. */
  toDecimalString(): string {
    return formatUnits(this.minorUnits, scaleOf(this.currency));
  }

  /**
   * Format for a provider that demands a specific number of decimal places.
   *
   * Widening pads with zeros. Narrowing is refused unless the digits being
   * dropped are all zero — silently truncating a minor unit on the way to a
   * bank is the defect this method exists to prevent.
   */
  toProviderDecimal(scale: number): string {
    if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
      throw new AmountPrecisionError(
        this.toDecimalString(),
        this.currency,
        scale,
      );
    }
    const own = scaleOf(this.currency);
    if (scale === own) {
      return this.toDecimalString();
    }
    if (scale > own) {
      const widened = this.minorUnits * 10n ** BigInt(scale - own);
      return formatUnits(widened, scale);
    }
    const divisor = 10n ** BigInt(own - scale);
    if (this.minorUnits % divisor !== 0n) {
      throw new AmountPrecisionError(
        this.toDecimalString(),
        this.currency,
        scale,
      );
    }
    return formatUnits(this.minorUnits / divisor, scale);
  }

  toJson(): MoneyJson {
    return { minorUnits: this.minorUnits.toString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
