import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { TestClock, parseInstant } from "@baas/platform";
import {
  JwksKeySource,
  OIDC_SIGNING_ALGORITHMS,
  OidcError,
  OidcVerifier,
  StaticKeySource,
} from "./oidc.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CONFIG = { issuer: "https://idp.test", audience: "baas-portal" };
const verifier = new OidcVerifier(CONFIG, new StaticKeySource(publicKey));

function idToken(
  claims: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
) {
  return jwt.sign({ sub: "operator-1", ...claims }, privateKey, {
    algorithm: "RS256",
    issuer: CONFIG.issuer,
    audience: CONFIG.audience,
    expiresIn: "5m",
    ...options,
  });
}

describe("verifying an operator's identity", () => {
  it("accepts a well-formed token and reads the identity", async () => {
    const identity = await verifier.verify(
      idToken({ email: "ops@example.com", name: "An Operator" }),
    );
    expect(identity).toEqual({
      issuer: "https://idp.test",
      subject: "operator-1",
      email: "ops@example.com",
      displayName: "An Operator",
    });
  });

  it("tolerates a token with no email or name", async () => {
    const identity = await verifier.verify(idToken());
    expect(identity.email).toBeUndefined();
  });

  it.each<[string, jwt.SignOptions]>([
    ["a different issuer", { issuer: "https://elsewhere" }],
    ["a different audience", { audience: "someone-else" }],
    ["an expired token", { expiresIn: "-1m" }],
  ])("refuses %s", async (_label, options) => {
    await expect(verifier.verify(idToken({}, options))).rejects.toThrow(
      OidcError,
    );
  });

  it("refuses an algorithm the token chose for itself", async () => {
    // Honouring `alg` from the token is how `none` and HS256-signed-with-the-
    // public-key attacks work. The list is ours.
    const forged = jwt.sign({ sub: "operator-1" }, publicKey, {
      algorithm: "HS256",
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
      expiresIn: "5m",
    });
    await expect(verifier.verify(forged)).rejects.toThrow(
      /refusing algorithm HS256/,
    );
    expect(OIDC_SIGNING_ALGORITHMS).toEqual(["RS256", "ES256"]);
  });

  it("refuses a token with no subject", async () => {
    const anonymous = jwt.sign({}, privateKey, {
      algorithm: "RS256",
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
      expiresIn: "5m",
    });
    await expect(verifier.verify(anonymous)).rejects.toThrow(/no subject/);
  });

  it("refuses to verify at all when issuer or audience is unconfigured", async () => {
    // The same rule as the mobile assertion: never skip the check when it is
    // unset, because that default is what makes a control environment-specific.
    const unconfigured = new OidcVerifier(
      { ...CONFIG, issuer: "" },
      new StaticKeySource(publicKey),
    );
    await expect(unconfigured.verify(idToken())).rejects.toThrow(
      /required in every environment/,
    );
  });

  it("refuses something that is not a JWT", async () => {
    await expect(verifier.verify("not-a-token")).rejects.toThrow(/not a JWT/);
  });
});

describe("JWKS", () => {
  const clock = new TestClock(parseInstant("2026-09-27T19:00:00.000Z"));

  function jwks(keys: unknown[], onFetch?: () => void) {
    return (() => {
      onFetch?.();
      return Promise.resolve(
        new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
  }

  it("refuses a token with no key id", async () => {
    const source = new JwksKeySource("https://idp.test/jwks", clock, jwks([]));
    await expect(source.keyFor(undefined)).rejects.toThrow(/no key id/);
  });

  it("does not refetch for the same unknown key id", async () => {
    // Otherwise a forged `kid` is a way to make us hammer the provider.
    let fetches = 0;
    const source = new JwksKeySource(
      "https://idp.test/jwks",
      clock,
      jwks([], () => {
        fetches += 1;
      }),
    );
    await expect(source.keyFor("ghost")).rejects.toThrow(/no such signing key/);
    await expect(source.keyFor("ghost")).rejects.toThrow(/no such signing key/);
    expect(fetches).toBe(1);
  });

  it("reports an unreachable JWKS endpoint as such", async () => {
    const failing = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const source = new JwksKeySource("https://idp.test/jwks", clock, failing);
    await expect(source.keyFor("kid-1")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("skips a key it cannot read rather than rejecting the whole set", async () => {
    // A provider rotating to an algorithm we do not support should not take
    // down sign-in for the keys we do.
    const source = new JwksKeySource(
      "https://idp.test/jwks",
      clock,
      jwks([{ kid: "broken", kty: "OKP", crv: "Ed448", x: "nonsense" }]),
    );
    await expect(source.keyFor("broken")).rejects.toThrow(
      /no such signing key/,
    );
  });
});
