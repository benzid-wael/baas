import { describe, expect, it } from "vitest";
import { Money } from "@baas/domain";
import {
  fromMoney,
  instantSchema,
  moneySchema,
  pageOf,
  slugSchema,
  toMoney,
  uuidSchema,
} from "./primitives.js";
import { z } from "zod";

describe("money on the wire", () => {
  it.each([
    ["11.00", "AED"],
    ["0.00", "USD"],
    ["-1.50", "GBP"],
    ["1500", "JPY"],
    ["1.234", "KWD"],
  ])("accepts %s %s at the currency's own scale", (amount, currency) => {
    expect(moneySchema.safeParse({ amount, currency }).success).toBe(true);
  });

  it.each([
    ["11", "AED", "too few decimals"],
    ["11.0", "AED", "too few decimals"],
    ["11.000", "AED", "too many decimals"],
    ["1500.00", "JPY", "a zero-scale currency takes none"],
    ["1.23", "KWD", "a three-scale currency takes three"],
    ["1e3", "USD", "not a decimal string"],
    ["1,00", "USD", "not a decimal string"],
  ])("refuses %s %s: %s", (amount, currency) => {
    expect(moneySchema.safeParse({ amount, currency }).success).toBe(false);
  });

  it("refuses a JSON number, because a double is not money", () => {
    expect(
      moneySchema.safeParse({ amount: 11.0, currency: "AED" }).success,
    ).toBe(false);
  });

  it("means equal amounts always have identical representations", () => {
    // The incumbent compared "11.00" with "11" across a boundary and got the
    // wrong answer. Canonical form removes the possibility.
    const a = fromMoney(Money.of("11", "AED"));
    const b = fromMoney(Money.of("11.00", "AED"));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("round-trips through the domain type", () => {
    const money = Money.of("1234.56", "AED");
    expect(toMoney(fromMoney(money)).isSameAs(money)).toBe(true);
  });

  it("names the expected scale so a client can fix the call", () => {
    const result = moneySchema.safeParse({ amount: "1.5", currency: "KWD" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("3 decimal places");
    expect(result.error?.issues[0]?.path).toEqual(["amount"]);
  });
});

describe("instants on the wire", () => {
  it("accepts one representation only", () => {
    expect(instantSchema.safeParse("2026-09-26T12:00:00.000Z").success).toBe(
      true,
    );
  });

  it.each([
    "2026-09-26T12:00:00Z",
    "2026-09-26T12:00:00.000+04:00",
    "2026-09-26",
    "2026-09-26T12:00:00.000",
  ])("refuses %o so a client never has to guess a zone", (bad) => {
    expect(instantSchema.safeParse(bad).success).toBe(false);
  });
});

describe("identifiers", () => {
  it("accepts a uuid and refuses anything else", () => {
    expect(
      uuidSchema.safeParse("0192f3a4-5b6c-7d8e-8f90-123456789abc").success,
    ).toBe(true);
    expect(uuidSchema.safeParse("nope").success).toBe(false);
  });

  it.each(["ruya", "keel", "acme-bank", "acme_bank"])(
    "accepts slug %o",
    (v) => {
      expect(slugSchema.safeParse(v).success).toBe(true);
    },
  );

  it.each(["Ruya", "2bank", "-x", "x-", "a".repeat(65)])(
    "refuses slug %o",
    (v) => {
      expect(slugSchema.safeParse(v).success).toBe(false);
    },
  );
});

describe("pagination", () => {
  const page = pageOf(z.string());

  it("is cursor-based, and the cursor is optional on the last page", () => {
    expect(page.safeParse({ items: ["a"] }).success).toBe(true);
    expect(page.safeParse({ items: [], nextCursor: "abc" }).success).toBe(true);
  });

  it("requires items even when empty", () => {
    expect(page.safeParse({}).success).toBe(false);
  });
});
