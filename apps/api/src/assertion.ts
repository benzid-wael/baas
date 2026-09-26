import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * Verification of the BFF's per-request user assertion (task T9, finding N1).
 *
 * The end user's wallet-auth JWT never reaches this service. Identity arrives
 * as `x-sc-user-uuid` plus a short-lived ES256 assertion the BFF signs; we
 * hold only the public key and fail closed without it.
 *
 * **`issuer` and `audience` are required in every environment, including
 * dev.** The incumbent requires them in stage and production only, while the
 * BFF's `signUserAssertion` mints `{sub, iat, exp}` and nothing else — so
 * every mobile request 401s in stage and production and works perfectly in
 * dev. Requiring them everywhere means the BFF change is forced where it is
 * cheap, and the failure cannot be environment-specific.
 */
export interface AssertionConfig {
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
  readonly maxAgeSeconds?: number;
}

export interface VerifiedAssertion {
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class AssertionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AssertionError";
  }
}

export function verifyAssertion(
  token: string,
  config: AssertionConfig,
): VerifiedAssertion {
  if (config.issuer === "" || config.audience === "") {
    // Never "verify without them if they are unset". That default is what
    // makes a control environment-specific.
    throw new AssertionError(
      "assertion.misconfigured",
      "issuer and audience are required in every environment",
    );
  }

  let payload: jwt.JwtPayload;
  try {
    // `createPublicKey` returns a KeyObject whose declared key-type union is
    // wider than jsonwebtoken's parameter type; the runtime value is an EC key.
    const key = createPublicKey(config.publicKeyPem) as unknown as jwt.Secret;
    const verified = jwt.verify(token, key, {
      algorithms: ["ES256"],
      issuer: config.issuer,
      audience: config.audience,
      maxAge: config.maxAgeSeconds ?? 120,
      complete: false,
    });
    if (typeof verified === "string") {
      throw new AssertionError(
        "assertion.malformed",
        "assertion is not a JSON payload",
      );
    }
    payload = verified;
  } catch (error) {
    if (error instanceof AssertionError) {
      throw error;
    }
    throw new AssertionError(
      "assertion.invalid",
      error instanceof Error
        ? error.message
        : "assertion could not be verified",
    );
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new AssertionError(
      "assertion.no_subject",
      "assertion has no subject",
    );
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    throw new AssertionError(
      "assertion.no_lifetime",
      "assertion must carry iat and exp",
    );
  }

  return { subject, issuedAt: payload.iat, expiresAt: payload.exp };
}
