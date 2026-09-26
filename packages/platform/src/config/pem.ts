/**
 * PEM material arrives base64-encoded on a single line.
 *
 * A multi-line PEM does not survive every transport this platform uses — the
 * dev bridge mangles the newlines, and the resulting failure is an ES256
 * "must be an asymmetric key" error several layers from the cause. Encoding
 * the whole PEM as one base64 blob removes the class of problem, and both this
 * service and the BFF decode it the same way.
 *
 * A literal PEM is still accepted, because refusing it would only teach people
 * to work around the check rather than fix their manifest.
 */
const PEM_BLOCK = /^-----BEGIN [A-Z ]+-----[\s\S]+-----END [A-Z ]+-----\s*$/;

export function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InvalidPemError("empty");
  }
  if (PEM_BLOCK.test(trimmed)) {
    return trimmed;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8");
  } catch (error) {
    throw new InvalidPemError("not decodable as base64", { cause: error });
  }

  const normalized = decoded.trim();
  if (!PEM_BLOCK.test(normalized)) {
    throw new InvalidPemError(
      "neither a PEM block nor base64 of one (expected a single-line base64 PEM)",
    );
  }
  return normalized;
}

export function isPem(value: string): boolean {
  try {
    normalizePem(value);
    return true;
  } catch (error) {
    if (error instanceof InvalidPemError) {
      return false;
    }
    throw error;
  }
}

export class InvalidPemError extends Error {
  readonly code = "platform.config.invalid_pem";

  constructor(reason: string, options?: ErrorOptions) {
    super(`Invalid PEM: ${reason}`, options);
    this.name = "InvalidPemError";
  }
}
