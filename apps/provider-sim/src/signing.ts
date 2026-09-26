import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/**
 * The two signature schemes the partners actually use, reproduced exactly.
 *
 * A simulator that skips signing is worse than no simulator: it lets
 * verification code pass in development and fail in stage, which is the shape
 * of the N1 launch blocker. Both schemes are taken from the incumbent's
 * verifiers, so a body accepted here is a body accepted there.
 */

/**
 * Keel: Base64 RSA-SHA256, PKCS#1 v1.5, over the raw body.
 *
 * Outbound requests sign `${rawBody}${idempotencyId}` rather than the body
 * alone — so a replayed body under a different idempotency key does not carry
 * a valid signature.
 */
export function signKeel(
  rawBody: string,
  privateKeyPem: string,
  idempotencyId = "",
): string {
  return createSign("RSA-SHA256")
    .update(`${rawBody}${idempotencyId}`)
    .sign(privateKeyPem, "base64");
}

export const KEEL_SIGNATURE_HEADER = "x-digital-signature";

/** Ruya: hex HMAC-SHA256 over the raw body. */
export function signRuya(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export const RUYA_SIGNATURE_HEADER = "x-ruya-callback-signature";

/**
 * Constant-time comparison. The simulator verifies inbound requests too: an
 * adapter that signs incorrectly should fail here, in development, rather
 * than against a partner sandbox whose error message is "400".
 */
export function signatureMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (presented === undefined) {
    return false;
  }
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
