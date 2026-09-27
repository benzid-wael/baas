import { createSign } from "node:crypto";

/**
 * Keel's request signature: Base64 RSA-SHA256, PKCS#1 v1.5, over
 * `${rawBody}${idempotencyId}`.
 *
 * Lifted exactly, including the concatenation. Signing the body alone would
 * let a replayed body carry a valid signature under a different idempotency
 * key, which is precisely what the header exists to prevent — and the
 * simulator asserts this, so an adapter that gets it wrong fails in
 * development rather than against a sandbox that answers `400`.
 */
export function signKeelRequest(
  rawBody: string,
  idempotencyId: string,
  privateKeyPem: string,
): string {
  return createSign("RSA-SHA256")
    .update(`${rawBody}${idempotencyId}`)
    .sign(privateKeyPem, "base64");
}
