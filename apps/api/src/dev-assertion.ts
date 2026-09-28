import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Clock } from "@baas/domain";
import { normalizePem } from "@baas/platform";
import { SeedRefusedError } from "./seed.js";

/**
 * Mint the assertion the BFF would mint (New-25).
 *
 * The mobile surface requires `X-SC-USER-ASSERTION`, a short-lived ES256 token
 * the BFF signs and `baas` verifies with the public half. There is no BFF in
 * this repository, so without this the whole customer read surface — M1-5,
 * M1-8, M1-9 — is reachable only from the automated tests.
 *
 * **This impersonates a customer**, so it carries the seed's rules exactly:
 * dev only, refused before anything else happens, and reachable from no code
 * path the service runs. The key it uses is a **development** key and must
 * never be one a real BFF holds — which is why the default is to generate a
 * fresh throwaway pair and print both halves rather than to read one from
 * anywhere.
 */
export interface DevKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  /** The form `MOBILE_ASSERTION_PUBLIC_KEY` wants: single-line base64. */
  readonly publicKeyBase64: string;
  /**
   * The private half in the same single-line form, for the same reason.
   *
   * Running the tool found this: the first version printed the PEM across five
   * lines inside a shell `export`, and neither a copy-paste nor an `awk` range
   * survived it — the key came back with the shell syntax attached and
   * OpenSSL refused it. Single-line base64 is already this workspace's
   * convention for moving a key through an environment variable, and the
   * reason is exactly this.
   */
  readonly privateKeyBase64: string;
}

export function generateDevKeyPair(): DevKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    // Base64 of the PEM, because a multi-line PEM does not survive the dev
    // bridge and fails several layers from the cause as "must be an
    // asymmetric key". The service's config decodes it.
    publicKeyBase64: Buffer.from(publicKey, "utf8").toString("base64"),
    privateKeyBase64: Buffer.from(privateKey, "utf8").toString("base64"),
  };
}

export interface MintRequest {
  readonly appEnv: string;
  /** A PEM block, or single-line base64 of one. Both are accepted. */
  readonly privateKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
  readonly externalUserUuid: string;
  /** Short by design. The service refuses anything older than 120 seconds. */
  readonly lifetimeSeconds?: number;
}

export function mintAssertion(clock: Clock, request: MintRequest): string {
  if (request.appEnv !== "dev") {
    throw new SeedRefusedError(request.appEnv);
  }

  const issuedAt = Math.floor(clock.now().epochMilliseconds / 1000);
  return jwt.sign(
    {
      sub: request.externalUserUuid,
      iat: issuedAt,
      exp: issuedAt + (request.lifetimeSeconds ?? 60),
    },
    // `normalizePem` accepts either form, which is what lets the printed
    // single-line value be pasted straight back in.
    createPrivateKey(
      normalizePem(request.privateKeyPem),
    ) as unknown as jwt.Secret,
    {
      algorithm: "ES256",
      issuer: request.issuer,
      audience: request.audience,
    },
  );
}
