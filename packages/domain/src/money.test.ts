import { describe, expect, it } from "vitest";
import type { MoneyJson } from "./money.js";
import { Money } from "./money.js";
import {
  AmountPrecisionError,
  CurrencyMismatchError,
  InvalidAmountError,
  UnknownCurrencyError,
} from "./errors.js";
import type { CurrencyCode } from "./currency.js";

describe("Money.of", () => {
  it("parses the currency's own scale", () => {
    expect(Money.of("11.00", "AED").minorUnits).toBe(1100n);
    expect(Money.of("11", "AED").minorUnits).toBe(1100n);
    expect(Money.of("0", "AED").minorUnits).toBe(0n);
  });

  it("respects a zero-scale currency", () => {
    expect(Money.of("1500", "JPY").minorUnits).toBe(1500n);
    expect(Money.of("1500", "JPY").toDecimalString()).toBe("1500");
  });

  it("respects a three-scale currency", () => {
    expect(Money.of("1.234", "KWD").minorUnits).toBe(1234n);
    expect(Money.of("1.2", "KWD").minorUnits).toBe(1200n);
    expect(Money.of("1", "BHD").minorUnits).toBe(1000n);
  });

  it("parses negatives", () => {
    expect(Money.of("-0.01", "USD").minorUnits).toBe(-1n);
    expect(Money.of("-0", "USD").minorUnits).toBe(0n);
  });

  it("tolerates leading zeros", () => {
    expect(Money.of("007.50", "USD").minorUnits).toBe(750n);
  });

  it.each([
    "",
    " ",
    "1,00",
    "1.2.3",
    "1e3",
    "abc",
    "+1.00",
    ".5",
    "1.",
    " 1.00",
    "1.00 ",
    "Infinity",
    "NaN",
  ])("rejects %o as an amount", (bad) => {
    expect(() => Money.of(bad, "USD")).toThrow(InvalidAmountError);
  });

  it("refuses more precision than the currency permits rather than rounding", () => {
    expect(() => Money.of("0.001", "USD")).toThrow(AmountPrecisionError);
    expect(() => Money.of("0.1", "JPY")).toThrow(AmountPrecisionError);
    expect(() => Money.of("1.2345", "KWD")).toThrow(AmountPrecisionError);
  });

  it("rejects an unknown currency", () => {
    expect(() => Money.of("1.00", "XYZ" as CurrencyCode)).toThrow(
      UnknownCurrencyError,
    );
  });

  it("never routes the decimal through a float", () => {
    // The canonical float failure: 0.1 + 0.2 === 0.30000000000000004.
    const sum = Money.of("0.1", "USD").plus(Money.of("0.2", "USD"));
    expect(sum.isSameAs(Money.of("0.30", "USD"))).toBe(true);
    expect(sum.toDecimalString()).toBe("0.30");
  });

  it("holds an amount larger than Number.MAX_SAFE_INTEGER exactly", () => {
    const huge = Money.of("99999999999999999999.99", "USD");
    expect(huge.toDecimalString()).toBe("99999999999999999999.99");
  });
});

describe("Money arithmetic", () => {
  it("adds and subtracts within one currency", () => {
    const a = Money.of("10.00", "AED");
    const b = Money.of("2.50", "AED");
    expect(a.plus(b).toDecimalString()).toBe("12.50");
    expect(a.minus(b).toDecimalString()).toBe("7.50");
    expect(b.minus(a).toDecimalString()).toBe("-7.50");
  });

  it("refuses arithmetic across currencies", () => {
    const aed = Money.of("10.00", "AED");
    const usd = Money.of("10.00", "USD");
    expect(() => aed.plus(usd)).toThrow(CurrencyMismatchError);
    expect(() => aed.minus(usd)).toThrow(CurrencyMismatchError);
    expect(() => aed.compare(usd)).toThrow(CurrencyMismatchError);
  });

  it("negates and takes absolute value", () => {
    expect(Money.of("5.00", "USD").negated().toDecimalString()).toBe("-5.00");
    expect(Money.of("-5.00", "USD").absolute().toDecimalString()).toBe("5.00");
    expect(Money.of("5.00", "USD").absolute().toDecimalString()).toBe("5.00");
  });

  it("reports sign", () => {
    expect(Money.zero("USD").isZero()).toBe(true);
    expect(Money.of("-0.01", "USD").isNegative()).toBe(true);
    expect(Money.of("0.01", "USD").isPositive()).toBe(true);
    expect(Money.zero("USD").isPositive()).toBe(false);
  });

  it("orders by minor units", () => {
    const small = Money.of("1.00", "USD");
    const large = Money.of("2.00", "USD");
    expect(small.compare(large)).toBe(-1);
    expect(large.compare(small)).toBe(1);
    expect(small.compare(Money.of("1.00", "USD"))).toBe(0);
  });
});

describe("Money equality", () => {
  it("never compares formatted strings", () => {
    // "11.00" vs "11" across a boundary caused a false diagnosis in the
    // incumbent service. Both parse to the same minor units here.
    expect(Money.of("11.00", "AED").isSameAs(Money.of("11", "AED"))).toBe(true);
  });

  it("treats zero in different currencies as different", () => {
    expect(Money.zero("AED").isSameAs(Money.zero("USD"))).toBe(false);
  });
});

describe("Money.toProviderDecimal", () => {
  it("returns the canonical form at the currency's own scale", () => {
    expect(Money.of("11.50", "USD").toProviderDecimal(2)).toBe("11.50");
  });

  it("widens by padding", () => {
    expect(Money.of("11.50", "USD").toProviderDecimal(4)).toBe("11.5000");
    expect(Money.of("1500", "JPY").toProviderDecimal(2)).toBe("1500.00");
  });

  it("narrows only when nothing is lost", () => {
    expect(Money.of("11.00", "USD").toProviderDecimal(0)).toBe("11");
    expect(Money.of("1.200", "KWD").toProviderDecimal(2)).toBe("1.20");
  });

  it("refuses to narrow away a minor unit", () => {
    expect(() => Money.of("11.01", "USD").toProviderDecimal(0)).toThrow(
      AmountPrecisionError,
    );
    expect(() => Money.of("1.234", "KWD").toProviderDecimal(2)).toThrow(
      AmountPrecisionError,
    );
  });

  it("rejects a nonsensical scale", () => {
    for (const scale of [-1, 1.5, 7, Number.NaN]) {
      expect(() => Money.of("1.00", "USD").toProviderDecimal(scale)).toThrow(
        AmountPrecisionError,
      );
    }
  });

  it("formats negatives at every scale", () => {
    expect(Money.of("-1.50", "USD").toProviderDecimal(3)).toBe("-1.500");
    expect(Money.of("-1.00", "USD").toProviderDecimal(0)).toBe("-1");
  });
});

describe("Money serialisation", () => {
  const cases: ReadonlyArray<readonly [string, CurrencyCode]> = [
    ["0", "JPY"],
    ["-1500", "JPY"],
    ["0.00", "AED"],
    ["11.00", "AED"],
    ["-0.01", "USD"],
    ["1.234", "KWD"],
    ["99999999999999999999.99", "EUR"],
  ];

  it.each(cases)("round-trips %s %s through JSON", (amount, currency) => {
    const original = Money.of(amount, currency);
    const serialised = JSON.stringify(original.toJson());
    const restored = Money.fromJson(JSON.parse(serialised) as MoneyJson);
    expect(restored.isSameAs(original)).toBe(true);
    expect(restored.toDecimalString()).toBe(original.toDecimalString());
  });

  it("serialises minor units as a string, not a number", () => {
    expect(Money.of("11.00", "AED").toJson()).toEqual({
      minorUnits: "1100",
      currency: "AED",
    });
  });

  it("renders amount and currency together for logs", () => {
    expect(Money.of("11.00", "AED").toString()).toBe("11.00 AED");
  });
});

describe("Money construction helpers", () => {
  it("builds from minor units", () => {
    expect(Money.fromMinorUnits(1100n, "AED").toDecimalString()).toBe("11.00");
  });

  it("rejects an unknown currency from minor units", () => {
    expect(() => Money.fromMinorUnits(1n, "XYZ" as CurrencyCode)).toThrow(
      UnknownCurrencyError,
    );
  });

  it("is frozen", () => {
    const money = Money.of("1.00", "USD");
    expect(Object.isFrozen(money)).toBe(true);
  });
});
