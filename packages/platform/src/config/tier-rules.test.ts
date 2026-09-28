import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIER_DEFAULTS, TIER_RULES, applyTierContract } from "./schema.js";
import type { TierRule } from "./schema.js";

/**
 * The tier contract, as one declaration (New-9).
 *
 * The duplication this closed had a silent failure mode: the schema knew the
 * shape and the contract knew the requirement, so a rule added to one and not
 * the other was simply **not enforced in production**, and nothing failed. The
 * tests here are therefore about the *table* rather than about individual
 * rules — a rule that exists and does nothing is the thing to catch.
 */
const HARDENED: NodeJS.ProcessEnv = {
  APP_ENV: "production",
  DATABASE_SSL: "true",
  DATABASE_MIGRATIONS_RUN: "true",
  THROTTLE_STORAGE: "redis",
  REDIS_URL: "redis://redis:6379",
  OPENAPI_ENABLED: "false",
  OIDC_ISSUER: "https://idp.example",
  OIDC_AUDIENCE: "baas-portal",
  OIDC_JWKS_URI: "https://idp.example/jwks",
  APM_SERVER_URL: "https://apm.example",
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "a-real-enough-key-of-32-characters",
  DATABASE_PASSWORD: "a-real-enough-password-here",
};

function issues(env: NodeJS.ProcessEnv): { path: string; message: string }[] {
  const found: { path: string; message: string }[] = [];
  applyTierContract(env, "production", (path, message) => {
    found.push({ path: path.join("."), message });
  });
  return found;
}

/** An environment that violates exactly one rule. */
function violating(rule: TierRule): NodeJS.ProcessEnv {
  switch (rule.kind) {
    case "boolean":
      return { ...HARDENED, [rule.envKey]: rule.mustBe ? "false" : "true" };
    case "literal":
      return { ...HARDENED, [rule.envKey]: "something-else" };
    case "present":
    case "presentWhen":
      return { ...HARDENED, [rule.envKey]: "" };
    case "noPlaceholder":
      return { ...HARDENED, [rule.envKey]: "changeme-obviously-a-placeholder" };
  }
}

describe("a correctly hardened environment", () => {
  it("has nothing to report", () => {
    expect(issues(HARDENED)).toEqual([]);
  });

  it("is not checked at all in dev", () => {
    // Dev tolerates everything the contract forbids; that is the point of a
    // tier, and a contract that ran everywhere would make dev unusable.
    const found: string[] = [];
    applyTierContract({ APP_ENV: "dev" }, "dev", (path) => {
      found.push(path.join("."));
    });
    expect(found).toEqual([]);
  });
});

describe("every rule in the table does something", () => {
  // The heart of it. A rule can be added to `TIER_RULES` and be inert -- a
  // typo'd env key, a `kind` the loop does not handle -- and the deployment it
  // was meant to protect would pass. This iterates the table itself, so a rule
  // added tomorrow is covered today.
  for (const rule of TIER_RULES) {
    it(`${rule.envKey} is enforced, and reports at ${rule.path.join(".")}`, () => {
      const found = issues(violating(rule));
      expect(found.map((issue) => issue.path)).toContain(rule.path.join("."));
    });

    it(`${rule.envKey} explains itself`, () => {
      // A refusal that says "DATABASE_SSL must be true" gets argued with at
      // 2am; one that says why does not.
      const found = issues(violating(rule)).find(
        (issue) => issue.path === rule.path.join("."),
      );
      expect(found?.message).toContain(rule.because);
    });
  }
});

describe("the table and the schema cannot drift", () => {
  it("derives every default from a rule", () => {
    for (const rule of TIER_RULES) {
      if (rule.kind === "boolean" || rule.kind === "literal") {
        expect(TIER_DEFAULTS[rule.envKey]).toBe(rule.fallback);
      }
    }
  });

  it("offers a default only for a rule that has one", () => {
    const withDefaults = TIER_RULES.filter(
      (rule) => rule.kind === "boolean" || rule.kind === "literal",
    ).length;
    expect(Object.keys(TIER_DEFAULTS)).toHaveLength(withDefaults);
  });

  it("names only keys the loader actually reads", () => {
    // A rule for a key nothing wires into the config is a rule that protects a
    // setting the service does not have.
    const loader = readFileSync(join(import.meta.dirname, "load.ts"), "utf8");
    for (const rule of TIER_RULES) {
      expect(
        loader.includes(`env["${rule.envKey}"]`),
        `${rule.envKey} is a tier rule but the loader never reads it`,
      ).toBe(true);
    }
  });
});

describe("the conditional rule", () => {
  it("does not fire when the setting it depends on is not in play", () => {
    const found = issues({
      ...HARDENED,
      THROTTLE_STORAGE: "memory",
      REDIS_URL: "",
    });
    expect(found.map((issue) => issue.path)).toContain("throttle.storage");
    expect(found.map((issue) => issue.path)).not.toContain("throttle.redisUrl");
  });

  it("fires when it is", () => {
    const found = issues({ ...HARDENED, REDIS_URL: "" });
    expect(found.map((issue) => issue.path)).toEqual(["throttle.redisUrl"]);
  });
});

describe("every violation is reported, not just the first", () => {
  it("collects them all", () => {
    // The defect T3 fixed, in its other form: a deployment that learns one
    // rule per restart fixes six things in six deploys.
    const found = issues({
      APP_ENV: "production",
      DATABASE_SSL: "false",
      THROTTLE_STORAGE: "memory",
      OPENAPI_ENABLED: "true",
    });
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.map((issue) => issue.path)).toContain("database.ssl");
    expect(found.map((issue) => issue.path)).toContain("openApiEnabled");
    expect(found.map((issue) => issue.path)).toContain("oidc.issuer");
  });
});
