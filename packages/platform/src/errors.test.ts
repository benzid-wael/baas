import { describe, expect, it } from "vitest";
import { CurrencyMismatchError } from "@baas/domain";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("carries the stable code of a domain error", () => {
    const description = describeError(new CurrencyMismatchError("AED", "USD"));
    expect(description.code).toBe("domain.money.currency_mismatch");
    expect(description.name).toBe("CurrencyMismatchError");
    expect(description.message).toContain("AED");
    expect(description.stack).toBeDefined();
  });

  it("picks up a string code from a library error", () => {
    const error = Object.assign(new Error("connect refused"), {
      code: "ECONNREFUSED",
    });
    expect(describeError(error).code).toBe("ECONNREFUSED");
  });

  it("ignores a non-string code", () => {
    const error = Object.assign(new Error("odd"), { code: 42 });
    expect(describeError(error).code).toBeUndefined();
  });

  it("follows a cause chain to a bounded depth", () => {
    const root = new Error("root");
    const middle = new Error("middle", { cause: root });
    const top = new Error("top", { cause: middle });

    const description = describeError(top);
    expect(description.cause?.message).toBe("middle");
    expect(description.cause?.cause?.message).toBe("root");
    expect(description.cause?.cause?.cause).toBeUndefined();
  });

  it("does not recurse forever on a cyclic cause", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(() => describeError(first)).not.toThrow();
  });

  it.each([
    ["a string", "plain failure", "plain failure"],
    ["a number", 42, "42"],
    ["null", null, "null"],
    ["undefined", undefined, "<undefined>"],
    ["an object", { reason: "nope" }, '{"reason":"nope"}'],
  ])("describes %s rather than coercing it", (_label, thrown, expected) => {
    const description = describeError(thrown);
    expect(description.message).toBe(expected);
    expect(description.stack).toBeUndefined();
  });

  it("survives an unserialisable value", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(describeError(cyclic).message).toContain("unserialisable");
  });
});
