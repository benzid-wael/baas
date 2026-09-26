import type { Branded } from "./identifiers.js";
import type { Instant } from "./time.js";

/**
 * Ports the domain declares and infrastructure implements (RFC-BaaS §5.5).
 * Declared here, with no implementation, so that a use case can depend on the
 * seam without depending on the thing behind it.
 */

/**
 * The only sanctioned source of the current time.
 *
 * Review finding B4: 203 direct clock reads in the incumbent service made four
 * distinct expiry rules — a five-minute review, a ten-minute approval
 * proposal, ninety-second evidence freshness, an hourly provider check —
 * impossible to unit-test, and three separate expiry surprises cost time in a
 * single week.
 */
export interface Clock {
  now(): Instant;
}

/** A canonical UUID string. The generator decides the version; callers do not. */
export type Uuid = Branded<string, "Uuid">;

/**
 * The only sanctioned source of identifiers, so that tests are deterministic
 * and an id can be asserted rather than matched by shape.
 */
export interface IdGenerator {
  next(): Uuid;
}
