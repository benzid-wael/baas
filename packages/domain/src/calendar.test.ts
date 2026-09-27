import { describe, expect, it } from "vitest";
import {
  CalendarDate,
  UAE_OFFSET_MINUTES,
  daysInMonth,
  isLeapYear,
} from "./calendar.js";
import { InvalidCalendarDateError } from "./errors.js";
import { Duration } from "./time.js";

describe("leap years and month lengths", () => {
  it.each([
    [2024, true],
    [2026, false],
    [1900, false],
    [2000, true],
    [2100, false],
  ])("%i is a leap year: %s", (year, leap) => {
    expect(isLeapYear(year)).toBe(leap);
  });

  it("knows February", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it("rejects 29 February in a common year and accepts it in a leap year", () => {
    expect(() => CalendarDate.of(2026, 2, 29)).toThrow(
      InvalidCalendarDateError,
    );
    expect(CalendarDate.of(2024, 2, 29).toString()).toBe("2024-02-29");
  });

  it.each([
    [2026, 4, 31],
    [2026, 0, 1],
    [2026, 13, 1],
    [2026, 1, 0],
  ])("rejects %i-%i-%i", (year, month, day) => {
    expect(() => CalendarDate.of(year, month, day)).toThrow(
      InvalidCalendarDateError,
    );
  });
});

describe("parsing", () => {
  it("accepts YYYY-MM-DD and nothing else", () => {
    expect(CalendarDate.parse("2026-03-01").toString()).toBe("2026-03-01");
  });

  it.each(["2026-3-1", "01/03/2026", "2026-03-01T00:00:00Z", "", "20260301"])(
    "refuses %o rather than guessing",
    (bad) => {
      // A lenient parser is how 01/02 becomes ambiguous.
      expect(() => CalendarDate.parse(bad)).toThrow(InvalidCalendarDateError);
    },
  );
});

describe("epoch-day round trip", () => {
  it("is exact at the epoch", () => {
    expect(CalendarDate.of(1970, 1, 1).toEpochDay()).toBe(0);
    expect(CalendarDate.fromEpochDay(0).toString()).toBe("1970-01-01");
  });

  it("round-trips across centuries and leap boundaries", () => {
    for (const date of [
      "1900-02-28",
      "1900-03-01",
      "2000-02-29",
      "2024-02-29",
      "2026-12-31",
      "2100-03-01",
      "1969-12-31",
    ]) {
      const parsed = CalendarDate.parse(date);
      expect(CalendarDate.fromEpochDay(parsed.toEpochDay()).toString()).toBe(
        date,
      );
    }
  });

  it("counts days correctly across a leap day", () => {
    const before = CalendarDate.of(2024, 2, 28);
    expect(before.plusDays(1).toString()).toBe("2024-02-29");
    expect(before.plusDays(2).toString()).toBe("2024-03-01");
    expect(CalendarDate.of(2026, 2, 28).plusDays(1).toString()).toBe(
      "2026-03-01",
    );
  });
});

describe("month arithmetic", () => {
  it("clamps the day to the target month", () => {
    // 31 January plus one month is 28 February. Rolling into March is how a
    // monthly statement ends up dated in the wrong month.
    expect(CalendarDate.parse("2026-01-31").plusMonths(1).toString()).toBe(
      "2026-02-28",
    );
    expect(CalendarDate.parse("2024-01-31").plusMonths(1).toString()).toBe(
      "2024-02-29",
    );
    expect(CalendarDate.parse("2026-03-31").plusMonths(1).toString()).toBe(
      "2026-04-30",
    );
  });

  it("crosses years in both directions", () => {
    expect(CalendarDate.parse("2026-12-15").plusMonths(1).toString()).toBe(
      "2027-01-15",
    );
    expect(CalendarDate.parse("2026-01-15").plusMonths(-1).toString()).toBe(
      "2025-12-15",
    );
    expect(CalendarDate.parse("2026-06-15").plusMonths(-18).toString()).toBe(
      "2024-12-15",
    );
  });

  it("finds the ends of a month", () => {
    expect(CalendarDate.parse("2026-02-14").startOfMonth().toString()).toBe(
      "2026-02-01",
    );
    expect(CalendarDate.parse("2026-02-14").endOfMonth().toString()).toBe(
      "2026-02-28",
    );
    expect(CalendarDate.parse("2024-02-14").endOfMonth().toString()).toBe(
      "2024-02-29",
    );
  });
});

describe("a calendar date is not an instant until a zone is named", () => {
  it("resolves to a different instant in Dubai than in London", () => {
    // This is the whole reason the type exists. 1 March in Dubai begins four
    // hours before 1 March in UTC.
    const first = CalendarDate.parse("2026-03-01");
    const dubai = first.atStartOfDay(UAE_OFFSET_MINUTES);
    const utc = first.atStartOfDay(0);
    expect(utc.since(dubai).milliseconds).toBe(4 * 60 * 60 * 1000);
  });

  it("gives a statement period the same boundaries whatever the server's zone", () => {
    // The validation New-7 was written for. The boundaries depend on the
    // customer's offset and on nothing else.
    const month = CalendarDate.parse("2026-03-17");
    const from = month.startOfMonth().atStartOfDay(UAE_OFFSET_MINUTES);
    const to = month.endOfMonth().atEndOfDayExclusive(UAE_OFFSET_MINUTES);

    expect(from.epochMilliseconds).toBe(Date.UTC(2026, 1, 28, 20, 0, 0));
    expect(to.epochMilliseconds).toBe(Date.UTC(2026, 2, 31, 20, 0, 0));
  });

  it("a late-evening Dubai transaction falls in the right month", () => {
    // 2026-03-31 23:30 in Dubai is 19:30 UTC on the 31st, which a UTC-computed
    // boundary at midnight would push into April.
    const lateOnTheLastDay = CalendarDate.parse("2026-03-31")
      .atStartOfDay(UAE_OFFSET_MINUTES)
      .plus(Duration.ofHours(23).plus(Duration.ofMinutes(30)));
    const marchEnds =
      CalendarDate.parse("2026-03-31").atEndOfDayExclusive(UAE_OFFSET_MINUTES);
    expect(lateOnTheLastDay.isBefore(marchEnds)).toBe(true);
  });

  it("refuses an implausible offset", () => {
    expect(() =>
      CalendarDate.parse("2026-03-01").atStartOfDay(20 * 60),
    ).toThrow(InvalidCalendarDateError);
  });
});

describe("ordering", () => {
  it("compares", () => {
    const early = CalendarDate.parse("2026-03-01");
    const late = CalendarDate.parse("2026-03-02");
    expect(early.isBefore(late)).toBe(true);
    expect(late.isAfter(early)).toBe(true);
    expect(early.isSameAs(CalendarDate.parse("2026-03-01"))).toBe(true);
    expect(early.compare(late)).toBe(-1);
  });
});
