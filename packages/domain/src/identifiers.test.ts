import { describe, expect, it } from "vitest";
import {
  customerId,
  operationId,
  providerId,
  tenantId,
} from "./identifiers.js";
import { InvalidIdentifierError } from "./errors.js";

const UUID_V7 = "0192f3a4-5b6c-7d8e-8f90-123456789abc";

describe("uuid identifiers", () => {
  it("accepts a well-formed uuid and normalises case", () => {
    expect(customerId(UUID_V7.toUpperCase())).toBe(UUID_V7);
    expect(tenantId(UUID_V7)).toBe(UUID_V7);
  });

  it.each(["", "not-a-uuid", UUID_V7.slice(0, -1), `${UUID_V7}x`])(
    "rejects %o",
    (bad) => {
      expect(() => customerId(bad)).toThrow(InvalidIdentifierError);
    },
  );

  it("names the kind in the error so the wrong id type is obvious", () => {
    expect(() => tenantId("nope")).toThrow(/TenantId/);
  });
});

describe("slug identifiers", () => {
  it.each(["ruya", "keel", "lulu", "acme-bank", "acme_bank", "bank2"])(
    "accepts %o",
    (good) => {
      expect(providerId(good)).toBe(good);
    },
  );

  it.each([
    "",
    "Ruya",
    "2bank",
    "-ruya",
    "ruya-",
    "ruya--bank",
    "a".repeat(65),
  ])("rejects %o", (bad) => {
    expect(() => providerId(bad)).toThrow(InvalidIdentifierError);
  });
});

describe("operation identifiers", () => {
  it.each(["payout.uk_domestic", "account.open", "payout.cash_pickup"])(
    "accepts %o",
    (good) => {
      expect(operationId(good)).toBe(good);
    },
  );

  it.each(["payout", "", ".open", "account.", "Account.Open", "a".repeat(65)])(
    "rejects %o",
    (bad) => {
      expect(() => operationId(bad)).toThrow(InvalidIdentifierError);
    },
  );
});
