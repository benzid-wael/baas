import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { TestClock, parseInstant } from "@baas/platform";
import type { ProviderCredentials } from "@baas/platform";
import {
  IncompleteProviderError,
  KNOWN_PROVIDERS,
  adaptersOf,
  buildProviders,
  refuseIncompleteProviders,
} from "./registry.js";

const clock = new TestClock(parseInstant("2026-09-27T22:00:00.000Z"));

/**
 * A throwaway key, generated per run rather than pasted.
 *
 * Not for reproducibility — nothing here signs anything — but because the
 * secret gate refuses a private-key block in the repository, and it is right
 * to: a key literal in a test is a key literal, whatever the comment beside it
 * says.
 */
const SIGNING_KEY = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function credentials(
  overrides: Partial<ProviderCredentials> & { provider: string },
): ProviderCredentials {
  return {
    baseUrl: "https://sandbox.invalid",
    clientId: "id",
    clientSecret: "secret",
    httpTimeoutMs: 10_000,
    tokenRefreshBufferSeconds: 60,
    maxRetries: 2,
    ...overrides,
  };
}

const KEEL_COMPLETE = credentials({
  provider: "keel",
  accessTokenEndpoint: "https://sandbox.invalid/oauth/token",
  signingPrivateKeyPem: SIGNING_KEY,
});

const RUYA_COMPLETE = credentials({
  provider: "ruya",
  entity: "AE",
  languageCode: 1,
  userId: 2,
  channelId: 3,
});

describe("building adapters from configuration", () => {
  it("knows keel and ruya, and says so in one place", () => {
    expect(KNOWN_PROVIDERS).toEqual(["keel", "ruya"]);
  });

  it("builds a complete provider", () => {
    const [result] = buildProviders({
      providers: { keel: KEEL_COMPLETE },
      clock,
    });
    expect(result?.outcome.configured).toBe(true);
  });

  it("derives capabilities from the ports supplied, never from a list (N3)", () => {
    // Keel has no statement port, so it claims no statement capability — and
    // cannot claim one without supplying an implementation.
    const [keel] = adaptersOf(
      buildProviders({ providers: { keel: KEEL_COMPLETE }, clock }),
    );
    expect(keel?.accounts).toBeDefined();
    expect(keel?.transactions).toBeDefined();
    expect(keel?.statements).toBeUndefined();

    const [ruya] = adaptersOf(
      buildProviders({ providers: { ruya: RUYA_COMPLETE }, clock }),
    );
    expect(ruya?.statements).toBeDefined();
  });

  it("names every missing setting at once, not the first one", () => {
    // The same rule the configuration loader follows: one fix, not six
    // restarts each revealing one more rule.
    const [result] = buildProviders({
      providers: { keel: credentials({ provider: "keel" }) },
      clock,
    });
    expect(result?.outcome).toEqual({
      configured: false,
      missing: ["accessTokenEndpoint", "signingPrivateKeyPem"],
    });
  });

  it("refuses to build an adapter that would not work", () => {
    // Finding A1 in reverse: the adapter never gets to exist and then report
    // itself unavailable for reasons of its own.
    const built = adaptersOf(
      buildProviders({
        providers: { ruya: credentials({ provider: "ruya", entity: "AE" }) },
        clock,
      }),
    );
    expect(built).toEqual([]);
  });

  it("ignores a provider no factory recognises, rather than inventing one", () => {
    // `adapter_absent` is the capability registry's answer for this, and it is
    // the honest one for a provider this build predates.
    expect(
      buildProviders({
        providers: { lulu: credentials({ provider: "lulu" }) },
        clock,
      }),
    ).toEqual([]);
  });

  it("reports providers in a stable order", () => {
    const results = buildProviders({
      providers: { ruya: RUYA_COMPLETE, keel: KEEL_COMPLETE },
      clock,
    });
    expect(results.map((result) => result.providerId)).toEqual([
      "keel",
      "ruya",
    ]);
  });
});

describe("a hardened tier refuses a half-configured provider", () => {
  const incomplete = buildProviders({
    providers: { keel: credentials({ provider: "keel" }) },
    clock,
  });

  it("tolerates it in dev, because that is how you work on one provider", () => {
    expect(() => {
      refuseIncompleteProviders("dev", incomplete);
    }).not.toThrow();
  });

  for (const tier of ["stage", "production"]) {
    it(`refuses it in ${tier}, naming what is missing`, () => {
      // Finding A8: a correctly deployed service that is silently inert,
      // discovered by a customer rather than by a deploy.
      expect(() => {
        refuseIncompleteProviders(tier, incomplete);
      }).toThrow(IncompleteProviderError);
      try {
        refuseIncompleteProviders(tier, incomplete);
      } catch (error) {
        expect((error as Error).message).toContain("accessTokenEndpoint");
        expect((error as Error).message).toContain("signingPrivateKeyPem");
      }
    });
  }

  it("lets a complete one through in production", () => {
    expect(() => {
      refuseIncompleteProviders(
        "production",
        buildProviders({ providers: { keel: KEEL_COMPLETE }, clock }),
      );
    }).not.toThrow();
  });
});
