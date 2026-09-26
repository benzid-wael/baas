import { describe, expect, it } from "vitest";
import {
  AmountPrecisionError,
  CurrencyMismatchError,
  DomainError,
  InvalidAmountError,
  InvalidIdentifierError,
  UnknownCurrencyError,
} from "./errors.js";

const errors: readonly DomainError[] = [
  new UnknownCurrencyError("XYZ"),
  new InvalidAmountError("1,00", "USD"),
  new AmountPrecisionError("0.001", "USD", 2),
  new CurrencyMismatchError("AED", "USD"),
  new InvalidIdentifierError("TenantId", "nope"),
];

describe("domain error taxonomy", () => {
  it("gives every error a stable machine-readable code", () => {
    const codes = errors.map((error) => error.code);
    expect(codes).toEqual([
      "domain.currency.unknown",
      "domain.money.invalid_amount",
      "domain.money.precision",
      "domain.money.currency_mismatch",
      "domain.identifier.invalid",
    ]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("is a real Error with a useful name", () => {
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("carries the offending value for diagnosis", () => {
    expect(new InvalidAmountError("1,00", "USD").amount).toBe("1,00");
    expect(new AmountPrecisionError("0.001", "USD", 2).scale).toBe(2);
    expect(new CurrencyMismatchError("AED", "USD").right).toBe("USD");
  });
});
