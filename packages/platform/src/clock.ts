import { Instant } from "@baas/domain";
import type { Clock, Duration } from "@baas/domain";

/**
 * The only place in the codebase permitted to read the wall clock. A lint rule
 * enforces that; see `eslint.config.mjs`.
 */
export class SystemClock implements Clock {
  now(): Instant {
    return Instant.fromEpochMilliseconds(Date.now());
  }
}

/**
 * A clock under test control. Does not advance on its own — a test that needs
 * time to pass says so, which is the point.
 */
export class TestClock implements Clock {
  private current: Instant;

  constructor(start: Instant = Instant.EPOCH) {
    this.current = start;
  }

  now(): Instant {
    return this.current;
  }

  advanceBy(duration: Duration): Instant {
    this.current = this.current.plus(duration);
    return this.current;
  }

  setTo(instant: Instant): void {
    this.current = instant;
  }
}

/**
 * Render an instant as ISO-8601 in UTC.
 *
 * Formatting lives here rather than on `Instant` for the same reason provider
 * decimal formatting lives at the adapter boundary rather than on `Money`: it
 * is an output concern, and keeping it out of the domain is what lets the
 * domain depend on nothing.
 */
export function formatInstant(instant: Instant): string {
  return new Date(instant.epochMilliseconds).toISOString();
}

/**
 * Parse ISO-8601 into an instant.
 *
 * Deliberately stricter than `Date.parse`, which accepts implementation-defined
 * formats and silently reinterprets some of them in local time. Only a full
 * ISO-8601 instant with an explicit UTC or numeric offset is accepted, so a
 * timestamp without a zone can never be read as "probably UTC".
 */
export function parseInstant(value: string): Instant {
  if (!ISO_8601_INSTANT.test(value)) {
    throw new UnparsableInstantError(value);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new UnparsableInstantError(value);
  }
  return Instant.fromEpochMilliseconds(parsed);
}

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class UnparsableInstantError extends Error {
  readonly code = "platform.instant.unparsable";

  constructor(readonly value: string) {
    super(
      `Not an ISO-8601 instant with an explicit offset: ${JSON.stringify(value)}`,
    );
    this.name = "UnparsableInstantError";
  }
}
