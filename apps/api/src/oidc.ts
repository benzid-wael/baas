import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Clock } from "@baas/domain";

/**
 * Verifying an operator's ID token (MP-1).
 *
 * The identity provider can be named later; the **shape** cannot. Building
 * against a stub issuer in dev and a real one in production is only safe if
 * the verification is the same code in both, which is why the key source is a
 * port and the verification is not.
 */
export interface OidcConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Tolerance for clock skew between us and the provider. */
  readonly clockToleranceSeconds?: number;
}

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | undefined;
  readonly displayName: string | undefined;
}

/** Where a signing key comes from: a static key in dev, JWKS in production. */
export interface KeySource {
  keyFor(keyId: string | undefined): Promise<string>;
}

export class StaticKeySource implements KeySource {
  constructor(private readonly publicKeyPem: string) {}
  keyFor(): Promise<string> {
    return Promise.resolve(this.publicKeyPem);
  }
}

export class OidcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = `oidc.${code}`;
    this.name = "OidcError";
  }
}

const SIGNING_ALGORITHMS = ["RS256", "ES256"] as const;

export class OidcVerifier {
  constructor(
    private readonly config: OidcConfig,
    private readonly keys: KeySource,
  ) {}

  async verify(idToken: string): Promise<OidcIdentity> {
    if (this.config.issuer === "" || this.config.audience === "") {
      // The same rule as the mobile assertion: never "skip the check when it
      // is unset". That default is what makes a control environment-specific.
      throw new OidcError(
        "misconfigured",
        "issuer and audience are required in every environment",
      );
    }

    const decoded = jwt.decode(idToken, { complete: true });
    if (decoded === null) {
      throw new OidcError("malformed", "not a JWT");
    }
    // The algorithm is taken from our list, never from the token's own
    // header: honouring `alg` from the token is how `none` and HS256-with-the-
    // public-key attacks work.
    if (!SIGNING_ALGORITHMS.includes(decoded.header.alg as "RS256")) {
      throw new OidcError(
        "algorithm",
        `refusing algorithm ${decoded.header.alg}; expected one of ${SIGNING_ALGORITHMS.join(", ")}`,
      );
    }

    const key = await this.keys.keyFor(decoded.header.kid);

    let payload: jwt.JwtPayload;
    try {
      const verified = jwt.verify(
        idToken,
        createPublicKey(key) as unknown as jwt.Secret,
        {
          algorithms: [...SIGNING_ALGORITHMS],
          issuer: this.config.issuer,
          audience: this.config.audience,
          clockTolerance: this.config.clockToleranceSeconds ?? 30,
        },
      );
      if (typeof verified === "string") {
        throw new OidcError("malformed", "token payload is not an object");
      }
      payload = verified;
    } catch (error) {
      if (error instanceof OidcError) {
        throw error;
      }
      throw new OidcError(
        "invalid",
        error instanceof Error ? error.message : "could not verify the token",
      );
    }

    const subject = payload.sub;
    if (typeof subject !== "string" || subject === "") {
      throw new OidcError("no_subject", "token has no subject");
    }

    return {
      issuer: this.config.issuer,
      subject,
      email: stringOrUndefined(payload["email"]),
      displayName: stringOrUndefined(payload["name"]),
    };
  }
}

/**
 * JWKS, fetched and cached by key id.
 *
 * Refetches once when a key id is unknown, which is what makes provider key
 * rotation a non-event, and refuses to refetch repeatedly for the same
 * unknown id — otherwise a forged `kid` is a way to make us hammer the
 * provider.
 */
export class JwksKeySource implements KeySource {
  private cached = new Map<string, string>();
  private lastFetch = 0;

  constructor(
    private readonly jwksUri: string,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly minRefetchMs = 60_000,
  ) {}

  async keyFor(keyId: string | undefined): Promise<string> {
    if (keyId === undefined) {
      throw new OidcError("no_kid", "token has no key id and JWKS needs one");
    }
    const known = this.cached.get(keyId);
    if (known !== undefined) {
      return known;
    }

    const now = this.clock.now().epochMilliseconds;
    if (now - this.lastFetch < this.minRefetchMs) {
      throw new OidcError("unknown_key", "no such signing key");
    }

    this.lastFetch = now;
    this.cached = await this.fetchKeys();

    const fetched = this.cached.get(keyId);
    if (fetched === undefined) {
      throw new OidcError("unknown_key", "no such signing key");
    }
    return fetched;
  }

  private async fetchKeys(): Promise<Map<string, string>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.jwksUri, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new OidcError(
        "jwks_unreachable",
        error instanceof Error
          ? error.message
          : "could not reach the JWKS endpoint",
      );
    }
    if (!response.ok) {
      throw new OidcError(
        "jwks_unreachable",
        `JWKS endpoint returned ${response.status.toString()}`,
      );
    }

    const body = (await response.json()) as {
      keys?: {
        kid?: string;
        kty?: string;
        n?: string;
        e?: string;
        crv?: string;
        x?: string;
        y?: string;
      }[];
    };

    const keys = new Map<string, string>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid === undefined) {
        continue;
      }
      try {
        keys.set(
          jwk.kid,
          String(
            createPublicKey({ key: jwk, format: "jwk" }).export({
              type: "spki",
              format: "pem",
            }),
          ),
        );
      } catch {
        // A key we cannot read is not a reason to reject the whole set: a
        // provider rotating to an algorithm we do not support should not take
        // down sign-in for the keys we do.
        continue;
      }
    }
    return keys;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Exported so a test can prove the algorithm list is closed. */
export const OIDC_SIGNING_ALGORITHMS = SIGNING_ALGORITHMS;
