import { InvalidDurationError, InvalidInstantError } from "./errors.js";

/**
 * A duration, in whole milliseconds. Signed: a negative duration is legal and
 * means "earlier", which is what makes `Instant.plus` sufficient on its own.
 */
export class Duration {
  private constructor(readonly milliseconds: number) {
    Object.freeze(this);
  }

  static ofMilliseconds(milliseconds: number): Duration {
    if (!Number.isSafeInteger(milliseconds)) {
      throw new InvalidDurationError(milliseconds);
    }
    return new Duration(milliseconds);
  }

  static ofSeconds(seconds: number): Duration {
    return Duration.scaled(seconds, 1_000);
  }

  static ofMinutes(minutes: number): Duration {
    return Duration.scaled(minutes, 60_000);
  }

  static ofHours(hours: number): Duration {
    return Duration.scaled(hours, 3_600_000);
  }

  static ofDays(days: number): Duration {
    return Duration.scaled(days, 86_400_000);
  }

  static readonly ZERO = new Duration(0);

  plus(other: Duration): Duration {
    return Duration.ofMilliseconds(this.milliseconds + other.milliseconds);
  }

  negated(): Duration {
    return Duration.ofMilliseconds(-this.milliseconds);
  }

  isZero(): boolean {
    return this.milliseconds === 0;
  }

  isNegative(): boolean {
    return this.milliseconds < 0;
  }

  isSameAs(other: Duration): boolean {
    return this.milliseconds === other.milliseconds;
  }

  toString(): string {
    return `PT${(this.milliseconds / 1000).toString()}S`;
  }

  private static scaled(value: number, factor: number): Duration {
    if (!Number.isFinite(value)) {
      throw new InvalidDurationError(value);
    }
    return Duration.ofMilliseconds(Math.trunc(value * factor));
  }
}

/**
 * A point on the UTC timeline, as milliseconds since the epoch.
 *
 * Deliberately not a `Date`. `Date` carries a mutable API, a local-time
 * formatting surface and a parser that accepts almost anything, none of which
 * belong in a domain that must be reproducible. Rendering and parsing ISO-8601
 * are output concerns and live in `@baas/platform`, in the same way that
 * provider decimal formatting lives at the adapter boundary rather than on
 * `Money`.
 */
export class Instant {
  private constructor(readonly epochMilliseconds: number) {
    Object.freeze(this);
  }

  static fromEpochMilliseconds(epochMilliseconds: number): Instant {
    if (!Number.isSafeInteger(epochMilliseconds)) {
      throw new InvalidInstantError(epochMilliseconds);
    }
    return new Instant(epochMilliseconds);
  }

  static readonly EPOCH = new Instant(0);

  plus(duration: Duration): Instant {
    return Instant.fromEpochMilliseconds(
      this.epochMilliseconds + duration.milliseconds,
    );
  }

  minus(duration: Duration): Instant {
    return this.plus(duration.negated());
  }

  /** Signed: positive when `this` is later than `other`. */
  since(other: Instant): Duration {
    return Duration.ofMilliseconds(
      this.epochMilliseconds - other.epochMilliseconds,
    );
  }

  isBefore(other: Instant): boolean {
    return this.epochMilliseconds < other.epochMilliseconds;
  }

  isAfter(other: Instant): boolean {
    return this.epochMilliseconds > other.epochMilliseconds;
  }

  isSameAs(other: Instant): boolean {
    return this.epochMilliseconds === other.epochMilliseconds;
  }

  compare(other: Instant): -1 | 0 | 1 {
    if (this.isBefore(other)) return -1;
    if (this.isAfter(other)) return 1;
    return 0;
  }

  toString(): string {
    return `Instant(${this.epochMilliseconds.toString()})`;
  }
}
