import { describe, expect, it } from "vitest";
import { customerId } from "@baas/domain";
import { SequenceIdGenerator, UuidV7Generator } from "./ids.js";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("UuidV7Generator", () => {
  it("produces version 7 identifiers the domain accepts", () => {
    const generator = new UuidV7Generator();
    const value = generator.next();
    expect(value).toMatch(UUID_V7);
    expect(customerId(value)).toBe(value);
  });

  it("produces unique, time-ordered identifiers", () => {
    const generator = new UuidV7Generator();
    const values = Array.from({ length: 500 }, () => generator.next());

    expect(new Set(values).size).toBe(values.length);
    // Monotonic even within one millisecond: sorting must be a no-op.
    expect([...values].sort((a, b) => a.localeCompare(b))).toEqual(values);
  });
});

describe("SequenceIdGenerator", () => {
  it("yields the declared sequence so a test can assert an identifier", () => {
    const generator = new SequenceIdGenerator(["first", "second"]);
    expect(generator.next()).toBe("first");
    expect(generator.next()).toBe("second");
  });

  it("throws rather than falling back to randomness when exhausted", () => {
    const generator = new SequenceIdGenerator(["only"]);
    generator.next();
    expect(() => generator.next()).toThrow(/exhausted after 1/);
  });

  it("refuses an empty sequence", () => {
    expect(() => new SequenceIdGenerator([])).toThrow(/at least one/);
  });
});
