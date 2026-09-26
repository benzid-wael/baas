import { describe, expect, it } from "vitest";
import { Duration, Instant } from "./time.js";
import { InvalidDurationError, InvalidInstantError } from "./errors.js";

describe("Duration", () => {
  it("converts from each unit", () => {
    expect(Duration.ofSeconds(90).milliseconds).toBe(90_000);
    expect(Duration.ofMinutes(10).milliseconds).toBe(600_000);
    expect(Duration.ofHours(1).milliseconds).toBe(3_600_000);
    expect(Duration.ofDays(1).milliseconds).toBe(86_400_000);
  });

  it("is signed", () => {
    const negative = Duration.ofMinutes(5).negated();
    expect(negative.milliseconds).toBe(-300_000);
    expect(negative.isNegative()).toBe(true);
    expect(Duration.ZERO.isZero()).toBe(true);
  });

  it("adds and compares", () => {
    const total = Duration.ofMinutes(1).plus(Duration.ofSeconds(30));
    expect(total.isSameAs(Duration.ofSeconds(90))).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53])(
    "rejects %o milliseconds",
    (bad) => {
      expect(() => Duration.ofMilliseconds(bad)).toThrow(InvalidDurationError);
    },
  );

  it("rejects a non-finite unit value", () => {
    expect(() => Duration.ofMinutes(Number.NaN)).toThrow(InvalidDurationError);
  });

  it("renders as an ISO-8601 duration", () => {
    expect(Duration.ofSeconds(90).toString()).toBe("PT90S");
  });
});

describe("Instant", () => {
  const base = Instant.fromEpochMilliseconds(1_700_000_000_000);

  it("moves by a duration in both directions", () => {
    expect(base.plus(Duration.ofMinutes(10)).since(base).milliseconds).toBe(
      600_000,
    );
    expect(base.minus(Duration.ofMinutes(10)).isBefore(base)).toBe(true);
  });

  it("reports a signed difference", () => {
    const later = base.plus(Duration.ofSeconds(5));
    expect(later.since(base).milliseconds).toBe(5_000);
    expect(base.since(later).milliseconds).toBe(-5_000);
  });

  it("orders", () => {
    const later = base.plus(Duration.ofSeconds(1));
    expect(base.compare(later)).toBe(-1);
    expect(later.compare(base)).toBe(1);
    expect(
      base.compare(Instant.fromEpochMilliseconds(base.epochMilliseconds)),
    ).toBe(0);
    expect(base.isSameAs(later)).toBe(false);
  });

  it.each([Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    "rejects %o as epoch milliseconds",
    (bad) => {
      expect(() => Instant.fromEpochMilliseconds(bad)).toThrow(
        InvalidInstantError,
      );
    },
  );

  it("is frozen and has an unambiguous string form", () => {
    expect(Object.isFrozen(base)).toBe(true);
    expect(base.toString()).toBe("Instant(1700000000000)");
  });
});
