/**
 * Values that must never have a default in any schema, in any tier.
 *
 * A secret with a default is a secret that works in production until somebody
 * notices. The test suite parses an empty environment and asserts that every
 * key here is reported missing, so adding a default to one of these is a test
 * failure rather than a deployment.
 */
export const SECRET_ENV_KEYS = [
  "DATABASE_PASSWORD",
  "PROVIDER_CREDENTIAL_ENCRYPTION_KEY",
  "MOBILE_ASSERTION_PUBLIC_KEY",
  "CALLBACK_HMAC_SECRET",
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

/**
 * Values that are obviously not real, rejected in hardened tiers.
 *
 * `.env.example` uses these deliberately, so a developer can start the service
 * with no ceremony while stage and production refuse the same file. Matching
 * is on the normalised value, and a substring match is enough — a secret that
 * merely *contains* "changeme" is not a secret.
 */
export const PLACEHOLDER_MARKERS = [
  "changeme",
  "placeholder",
  "example",
  "insecure",
  "notasecret",
  "your-secret",
  "xxxx",
  "auth-disabled",
] as const;

export function looksLikePlaceholder(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return PLACEHOLDER_MARKERS.some((marker) =>
    normalized.includes(marker.replace(/[^a-z0-9-]/g, "")),
  );
}

/** Minimum length for anything used as a key or a signing secret. */
export const MIN_SECRET_LENGTH = 32;
