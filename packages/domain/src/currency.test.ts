import { describe, expect, it } from "vitest";
import {
  CURRENCY_SCALES,
  isCurrencyCode,
  scaleOf,
  toCurrencyCode,
} from "./currency.js";
import { UnknownCurrencyError } from "./errors.js";

describe("currency scales", () => {
  it("does not assume two decimal places", () => {
    expect(scaleOf("JPY")).toBe(0);
    expect(scaleOf("KWD")).toBe(3);
    expect(scaleOf("BHD")).toBe(3);
    expect(scaleOf("USD")).toBe(2);
  });

  it("declares a scale for every listed currency", () => {
    for (const [code, scale] of Object.entries(CURRENCY_SCALES)) {
      expect(Number.isInteger(scale)).toBe(true);
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("recognises known codes and rejects others", () => {
    expect(isCurrencyCode("AED")).toBe(true);
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(isCurrencyCode("aed")).toBe(false);
    expect(isCurrencyCode("toString")).toBe(false);
  });

  it("normalises case when parsing untrusted input", () => {
    expect(toCurrencyCode("aed")).toBe("AED");
    expect(() => toCurrencyCode("XYZ")).toThrow(UnknownCurrencyError);
  });
});
