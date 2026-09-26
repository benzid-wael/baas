import { describe, expect, it } from "vitest";
import { Instant } from "@baas/domain";
import {
  FEATURE_FLAGS,
  InvalidFlagExpiryError,
  expiryDeadline,
  findExpiredFlags,
  isValidExpiry,
} from "./flags.js";
import type { FeatureFlag } from "./flags.js";
import { formatInstant, parseInstant } from "../clock.js";

const A_FLAG: FeatureFlag = {
  env: "EXAMPLE_ENABLED",
  description: "Illustrative only; never declared in the real registry",
  owner: "platform-team",
  expires: "2026-06-30",
  default: false,
};

describe("expiry dates", () => {
  it("runs to the end of the declared day, in UTC", () => {
    expect(formatInstant(expiryDeadline("2026-06-30"))).toBe(
      "2026-06-30T23:59:59.999Z",
    );
  });

  it.each(["2026-6-30", "30-06-2026", "2026/06/30", "", "tomorrow", "2026-06"])(
    "refuses %o as an expiry",
    (bad) => {
      expect(isValidExpiry(bad)).toBe(false);
      expect(() => expiryDeadline(bad)).toThrow(InvalidFlagExpiryError);
    },
  );

  it("refuses a well-shaped but impossible date", () => {
    expect(isValidExpiry("2026-13-45")).toBe(false);
  });
});

describe("findExpiredFlags", () => {
  const deadline = parseInstant("2026-06-30T23:59:59.999Z");

  it("leaves a flag alone up to the last millisecond of its day", () => {
    expect(findExpiredFlags({ example: A_FLAG }, deadline)).toEqual([]);
  });

  it("reports it one millisecond later", () => {
    const expired = findExpiredFlags(
      { example: A_FLAG },
      Instant.fromEpochMilliseconds(deadline.epochMilliseconds + 1),
    );
    expect(expired.map((entry) => entry.name)).toEqual(["example"]);
    expect(expired[0]?.flag.owner).toBe("platform-team");
  });

  it("reports every expired flag, not the first", () => {
    const later = Instant.fromEpochMilliseconds(
      deadline.epochMilliseconds + 1_000,
    );
    const expired = findExpiredFlags(
      { one: A_FLAG, two: { ...A_FLAG, env: "OTHER_ENABLED" } },
      later,
    );
    expect(expired).toHaveLength(2);
  });
});

describe("the declared registry", () => {
  it("is empty, which is the correct resting state", () => {
    // Nothing in M0 needs a flag. Recovery is not a feature (finding A7), and
    // migrations are not opt-in. The first real entries are M1 cutover
    // switches, which have a reason to exist and a date to die.
    expect(Object.keys(FEATURE_FLAGS)).toEqual([]);
  });

  it("declares a valid owner and expiry for every flag it does hold", () => {
    for (const [name, flag] of Object.entries<FeatureFlag>(FEATURE_FLAGS)) {
      expect(flag.owner.trim().length, `${name} has no owner`).toBeGreaterThan(
        0,
      );
      expect(isValidExpiry(flag.expires), `${name} has no valid expiry`).toBe(
        true,
      );
    }
  });
});
