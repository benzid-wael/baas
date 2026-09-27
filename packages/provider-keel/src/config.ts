export interface KeelConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessTokenEndpoint: string;
  /** PEM, for the RSA request signature. Single-line base64 is decoded by config. */
  readonly signingPrivateKeyPem: string;
  readonly httpTimeoutMs: number;
  /** A pre-issued token, for a sandbox that does not run OAuth. */
  readonly bearerToken?: string;
}

/**
 * Keel's OAuth scope is derived from the base URL.
 *
 * Lifted exactly: the scope string is `{base}/read {base}/write {base}/admin`,
 * and getting it wrong produces a token that authenticates and then fails
 * authorisation on the first call, which reads as a permissions problem rather
 * than a configuration one.
 */
export function keelOauthScope(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/read ${base}/write ${base}/admin`;
}
