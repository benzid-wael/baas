import type { Instant } from "@baas/domain";
import { UnparsableInstantError, parseInstant } from "../clock.js";
import type { AppEnv } from "./app-env.js";

/**
 * A feature flag is a migration artefact, not a permanent switch.
 *
 * Review finding A8: the incumbent carries 31 boolean flags and 115
 * environment keys, several defaulting to a value no working environment
 * wants, so a correctly deployed service sat silently inert three separate
 * times in one week. The two structural causes were that nobody owned a flag
 * and nothing ever removed one.
 *
 * So a flag here must declare who owns it and when it expires. Both are
 * required fields, which makes omitting either a compile error, and an expired
 * flag fails the test suite rather than quietly becoming permanent.
 */
export interface FeatureFlag {
  /** Environment variable that sets it. */
  readonly env: string;
  /** What turning it on does. Written for whoever finds it in two years. */
  readonly description: string;
  /** A person or team. Not "platform". */
  readonly owner: string;
  /** ISO calendar date, `YYYY-MM-DD`. After this, CI fails until it is removed. */
  readonly expires: string;
  /** Value when the variable is absent. */
  readonly default: boolean;
  /** Tiers where the flag may not be enabled at all. */
  readonly forbiddenIn?: readonly AppEnv[];
}

const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Declared flags. Empty is the correct state; entries are temporary by
 * construction.
 *
 * Nothing in M0 needs a flag: the reconciler is not opt-in, migrations are not
 * opt-in, and recovery is not a feature (finding A7). The first genuine
 * entries will be M1 cutover switches, which are exactly the kind of flag this
 * registry is for — one that has a reason to exist and a date to die.
 */
export const FEATURE_FLAGS = {} as const satisfies Record<string, FeatureFlag>;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

/**
 * The last instant at which a flag is still within its declared life: the end
 * of its expiry day, in UTC.
 *
 * UTC rather than any deployment's local zone, so that the same flag expires
 * at the same moment everywhere and CI does not disagree with a laptop.
 */
export function expiryDeadline(expires: string): Instant {
  if (!EXPIRY.test(expires)) {
    throw new InvalidFlagExpiryError(expires);
  }
  try {
    return parseInstant(`${expires}T23:59:59.999Z`);
  } catch (error) {
    if (error instanceof UnparsableInstantError) {
      throw new InvalidFlagExpiryError(expires, { cause: error });
    }
    throw error;
  }
}

export interface ExpiredFlag {
  readonly name: string;
  readonly flag: FeatureFlag;
}

/**
 * Flags that have outlived their declared life.
 *
 * Pure and registry-agnostic so that the rule itself is testable without
 * declaring a real flag purely to watch it expire.
 */
export function findExpiredFlags(
  flags: Readonly<Record<string, FeatureFlag>>,
  now: Instant,
): readonly ExpiredFlag[] {
  return Object.entries(flags)
    .filter(([, flag]) => now.isAfter(expiryDeadline(flag.expires)))
    .map(([name, flag]) => ({ name, flag }));
}

export function isValidExpiry(expires: string): boolean {
  try {
    expiryDeadline(expires);
    return true;
  } catch (error) {
    if (error instanceof InvalidFlagExpiryError) {
      return false;
    }
    throw error;
  }
}

export class InvalidFlagExpiryError extends Error {
  readonly code = "platform.config.invalid_flag_expiry";

  constructor(
    readonly expires: string,
    options?: ErrorOptions,
  ) {
    super(
      `Feature flag expiry must be an ISO calendar date (YYYY-MM-DD): ${JSON.stringify(expires)}`,
      options,
    );
    this.name = "InvalidFlagExpiryError";
  }
}
