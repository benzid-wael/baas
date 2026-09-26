import { describe, expect, it } from "vitest";
import { Duration, Instant } from "@baas/domain";
import {
  SystemClock,
  TestClock,
  UnparsableInstantError,
  formatInstant,
  parseInstant,
} from "./clock.js";

describe("SystemClock", () => {
  it("reads the wall clock", () => {
    const before = Date.now();
    const observed = new SystemClock().now().epochMilliseconds;
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(Date.now());
  });
});

describe("TestClock", () => {
  it("does not advance on its own", () => {
    const clock = new TestClock(Instant.fromEpochMilliseconds(1_000));
    expect(clock.now().epochMilliseconds).toBe(1_000);
    expect(clock.now().epochMilliseconds).toBe(1_000);
  });

  it("advances only when told to", () => {
    const clock = new TestClock();
    clock.advanceBy(Duration.ofSeconds(30));
    expect(clock.now().epochMilliseconds).toBe(30_000);
  });

  it("can be set to an instant", () => {
    const clock = new TestClock();
    clock.setTo(Instant.fromEpochMilliseconds(5));
    expect(clock.now().epochMilliseconds).toBe(5);
  });
});

describe("expiry rules are testable (finding B4)", () => {
  /**
   * The incumbent's ten-minute approval-proposal window could not be
   * unit-tested at all, and expiry surprised three separate flows in one week.
   * This is that rule, expressed with the seam in place.
   */
  const APPROVAL_WINDOW = Duration.ofMinutes(10);

  it("holds open until the boundary and closes after it", () => {
    const clock = new TestClock(
      Instant.fromEpochMilliseconds(1_700_000_000_000),
    );
    const expiresAt = clock.now().plus(APPROVAL_WINDOW);

    const isExpired = (): boolean => clock.now().isAfter(expiresAt);

    expect(isExpired()).toBe(false);

    clock.advanceBy(Duration.ofMinutes(10).plus(Duration.ofMilliseconds(-1)));
    expect(isExpired()).toBe(false);

    clock.advanceBy(Duration.ofMilliseconds(1));
    expect(isExpired()).toBe(false); // exactly at the boundary is still open

    clock.advanceBy(Duration.ofMilliseconds(1));
    expect(isExpired()).toBe(true);
  });
});

describe("ISO-8601 conversion", () => {
  it("renders in UTC", () => {
    expect(formatInstant(Instant.fromEpochMilliseconds(0))).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("round-trips", () => {
    const instant = Instant.fromEpochMilliseconds(1_700_000_000_123);
    expect(parseInstant(formatInstant(instant)).isSameAs(instant)).toBe(true);
  });

  it("accepts an explicit numeric offset", () => {
    expect(parseInstant("2026-01-01T04:00:00+04:00").epochMilliseconds).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0),
    );
  });

  it.each([
    "2026-01-01",
    "2026-01-01T00:00:00",
    "2026-01-01 00:00:00Z",
    "not a date",
    "",
    "Mon, 01 Jan 2026 00:00:00 GMT",
  ])("refuses %o rather than guessing a zone", (bad) => {
    expect(() => parseInstant(bad)).toThrow(UnparsableInstantError);
  });

  it("refuses a well-shaped but impossible instant", () => {
    expect(() => parseInstant("2026-13-45T99:00:00Z")).toThrow(
      UnparsableInstantError,
    );
  });
});
