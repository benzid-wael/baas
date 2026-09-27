import { InvalidCalendarDateError } from "./errors.js";
import { Instant } from "./time.js";

/**
 * A date on a calendar: a year, a month and a day, with no time and no zone.
 *
 * **Deliberately not an `Instant` with the time zeroed.** RFC-BaaS §5.9 states
 * the rule; here is why it matters. A payout dated 2026-03-01 in Dubai is not
 * the same instant as one dated 2026-03-01 in London, and a statement period
 * whose boundaries are computed in UTC silently moves a UAE customer's
 * late-evening transaction into the previous month. "1 March" is a fact about
 * a calendar, and it stays one until somebody names a zone.
 *
 * Converting to an instant therefore **requires an offset**, and the method
 * that does it says so in its name. There is no default, because a default
 * would be UTC and UTC is the wrong answer for every customer this service
 * has.
 */
export class CalendarDate {
  private constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {
    Object.freeze(this);
  }

  static of(year: number, month: number, day: number): CalendarDate {
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      year < 1 ||
      year > 9999 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month)
    ) {
      throw new InvalidCalendarDateError(
        `${String(year)}-${String(month)}-${String(day)}`,
      );
    }
    return new CalendarDate(year, month, day);
  }

  /** `YYYY-MM-DD`, and nothing else. A lenient parser is how 01/02 becomes ambiguous. */
  static parse(value: string): CalendarDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) {
      throw new InvalidCalendarDateError(value);
    }
    return CalendarDate.of(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
  }

  toString(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  isSameAs(other: CalendarDate): boolean {
    return this.compare(other) === 0;
  }

  isBefore(other: CalendarDate): boolean {
    return this.compare(other) < 0;
  }

  isAfter(other: CalendarDate): boolean {
    return this.compare(other) > 0;
  }

  compare(other: CalendarDate): -1 | 0 | 1 {
    const left = this.toEpochDay();
    const right = other.toEpochDay();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  plusDays(days: number): CalendarDate {
    if (!Number.isSafeInteger(days)) {
      throw new InvalidCalendarDateError(String(days));
    }
    return CalendarDate.fromEpochDay(this.toEpochDay() + days);
  }

  /**
   * Add whole months, clamping the day to the target month's length.
   *
   * 31 January plus one month is 28 February, or 29 in a leap year. Every
   * other answer is worse: rolling into March is how a monthly statement ends
   * up dated in the wrong month, and refusing is how a perfectly ordinary
   * date becomes an error.
   */
  plusMonths(months: number): CalendarDate {
    if (!Number.isSafeInteger(months)) {
      throw new InvalidCalendarDateError(String(months));
    }
    const total = this.year * 12 + (this.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    return CalendarDate.of(
      year,
      month,
      Math.min(this.day, daysInMonth(year, month)),
    );
  }

  startOfMonth(): CalendarDate {
    return CalendarDate.of(this.year, this.month, 1);
  }

  endOfMonth(): CalendarDate {
    return CalendarDate.of(
      this.year,
      this.month,
      daysInMonth(this.year, this.month),
    );
  }

  /**
   * The first instant of this date **in a given zone offset**.
   *
   * Offsets in minutes, not IANA zone names: the domain depends on nothing, so
   * it has no time-zone database. That is a real limitation and it is stated
   * rather than hidden — it is correct for the Gulf, which has no daylight
   * saving, and a caller in a zone that does must supply the offset that
   * applied on the day in question.
   */
  atStartOfDay(offsetMinutes: number): Instant {
    if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 18 * 60) {
      throw new InvalidCalendarDateError(`offset ${String(offsetMinutes)}`);
    }
    return Instant.fromEpochMilliseconds(
      this.toEpochDay() * 86_400_000 - offsetMinutes * 60_000,
    );
  }

  /** The first instant of the *next* day, so a period is [start, end). */
  atEndOfDayExclusive(offsetMinutes: number): Instant {
    return this.plusDays(1).atStartOfDay(offsetMinutes);
  }

  /** Days since 1970-01-01. Hinnant's civil-from-days, inverted. */
  toEpochDay(): number {
    const year = this.month <= 2 ? this.year - 1 : this.year;
    const era = Math.floor(year / 400);
    const yearOfEra = year - era * 400;
    const dayOfYear =
      Math.floor((153 * (this.month + (this.month > 2 ? -3 : 9)) + 2) / 5) +
      this.day -
      1;
    const dayOfEra =
      yearOfEra * 365 +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100) +
      dayOfYear;
    return era * 146_097 + dayOfEra - 719_468;
  }

  static fromEpochDay(epochDay: number): CalendarDate {
    const shifted = epochDay + 719_468;
    const era = Math.floor(shifted / 146_097);
    const dayOfEra = shifted - era * 146_097;
    const yearOfEra = Math.floor(
      (dayOfEra -
        Math.floor(dayOfEra / 1460) +
        Math.floor(dayOfEra / 36_524) -
        Math.floor(dayOfEra / 146_096)) /
        365,
    );
    const year = yearOfEra + era * 400;
    const dayOfYear =
      dayOfEra -
      (365 * yearOfEra +
        Math.floor(yearOfEra / 4) -
        Math.floor(yearOfEra / 100));
    const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
    const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
    const month = monthPrime + (monthPrime < 10 ? 3 : -9);
    return CalendarDate.of(month <= 2 ? year + 1 : year, month, day);
  }
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/** +04:00. The Gulf has no daylight saving, so one offset is the whole story. */
export const UAE_OFFSET_MINUTES = 4 * 60;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
