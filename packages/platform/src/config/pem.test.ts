import { describe, expect, it } from "vitest";
import { InvalidPemError, isPem, normalizePem } from "./pem.js";
import {
  TEST_ASSERTION_PUBLIC_KEY_B64,
  TEST_ASSERTION_PUBLIC_KEY_PEM,
} from "./fixtures.js";

describe("normalizePem", () => {
  it("decodes the single-line base64 form deployments use", () => {
    expect(normalizePem(TEST_ASSERTION_PUBLIC_KEY_B64)).toBe(
      TEST_ASSERTION_PUBLIC_KEY_PEM,
    );
  });

  it("accepts a literal PEM block unchanged", () => {
    expect(normalizePem(TEST_ASSERTION_PUBLIC_KEY_PEM)).toBe(
      TEST_ASSERTION_PUBLIC_KEY_PEM,
    );
  });

  it("tolerates surrounding whitespace from a manifest", () => {
    expect(normalizePem(`\n  ${TEST_ASSERTION_PUBLIC_KEY_B64}  \n`)).toBe(
      TEST_ASSERTION_PUBLIC_KEY_PEM,
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["not base64 of anything", "!!!!"],
    ["base64 of something that is not a PEM", "aGVsbG8gd29ybGQ="],
    ["a truncated PEM", "-----BEGIN PUBLIC KEY-----\nabc"],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizePem(value)).toThrow(InvalidPemError);
    expect(isPem(value)).toBe(false);
  });

  it("names the reason so a manifest can be fixed without guessing", () => {
    expect(() => normalizePem("aGVsbG8=")).toThrow(/single-line base64 PEM/);
  });
});
