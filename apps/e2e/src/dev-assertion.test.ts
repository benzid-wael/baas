import { describe, expect, it } from "vitest";
import { SystemClock } from "@baas/platform";
import {
  SeedRefusedError,
  generateDevKeyPair,
  mintAssertion,
  verifyAssertion,
} from "@baas/api";

/**
 * The development assertion tool (New-25).
 *
 * The assertion it mints has to be one the **service's own verifier** accepts —
 * so that is what checks it here, rather than a second implementation that
 * could agree with the tool and disagree with production.
 */
/**
 * The **real** clock, deliberately.
 *
 * An earlier version froze it at a fixed instant and minted a 60-second
 * assertion from that — then verified it with `jsonwebtoken`, which reads the
 * real clock. The test passed for the one minute a day when the two agreed and
 * failed every other time. A frozen clock is right when both sides read it;
 * here only one does.
 */
const ISSUER = "https://bff.local";
const AUDIENCE = "baas";
const SUBJECT = "0192f3a4-5b6c-7d8e-8f90-000000000001";

const pair = generateDevKeyPair();
const clock = new SystemClock();

function mint(overrides: Partial<Parameters<typeof mintAssertion>[1]> = {}) {
  return mintAssertion(clock, {
    appEnv: "dev",
    privateKeyPem: pair.privateKeyPem,
    issuer: ISSUER,
    audience: AUDIENCE,
    externalUserUuid: SUBJECT,
    ...overrides,
  });
}

const config = {
  publicKeyPem: pair.publicKeyPem,
  issuer: ISSUER,
  audience: AUDIENCE,
};

describe("the assertion it mints", () => {
  it("is accepted by the service's own verifier", () => {
    expect(verifyAssertion(mint(), config).subject).toBe(SUBJECT);
  });

  it("is short-lived, because the service refuses an old one", () => {
    const verified = verifyAssertion(mint(), config);
    expect(verified.expiresAt - verified.issuedAt).toBeLessThanOrEqual(120);
  });

  it("is refused by a service configured for a different issuer", () => {
    expect(() =>
      verifyAssertion(mint(), { ...config, issuer: "https://somewhere.else" }),
    ).toThrow();
  });

  it("is refused by a service holding a different key", () => {
    expect(() =>
      verifyAssertion(mint(), {
        ...config,
        publicKeyPem: generateDevKeyPair().publicKeyPem,
      }),
    ).toThrow();
  });
});

describe("the key pair", () => {
  it("prints the public half in the single-line form config wants", () => {
    // A multi-line PEM does not survive the dev bridge and fails several
    // layers from the cause as "must be an asymmetric key".
    expect(pair.publicKeyBase64).not.toContain("\n");
    expect(
      Buffer.from(pair.publicKeyBase64, "base64").toString("utf8"),
    ).toContain("BEGIN PUBLIC KEY");
  });

  it("accepts its own printed private half back", () => {
    // Running the tool found that it did not: the first version printed a
    // five-line PEM inside a shell `export`, and neither copy-paste nor awk
    // survived it. This asserts the round trip the instructions describe.
    const minted = mintAssertion(clock, {
      appEnv: "dev",
      privateKeyPem: pair.privateKeyBase64,
      issuer: ISSUER,
      audience: AUDIENCE,
      externalUserUuid: SUBJECT,
    });
    expect(verifyAssertion(minted, config).subject).toBe(SUBJECT);
  });

  it("prints the private half on one line too", () => {
    expect(pair.privateKeyBase64).not.toContain("\n");
  });

  it("is different every time, so no key becomes the one everybody uses", () => {
    expect(generateDevKeyPair().privateKeyPem).not.toBe(pair.privateKeyPem);
  });
});

describe("where it refuses to run", () => {
  for (const appEnv of ["stage", "production"]) {
    it(`refuses ${appEnv}`, () => {
      // It impersonates a customer. Outside dev that is not a command
      // somebody runs.
      expect(() => mint({ appEnv })).toThrow(SeedRefusedError);
    });
  }
});
