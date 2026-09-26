/**
 * A real, throwaway P-256 public key, used by tests and by `.env.example`.
 *
 * A public key is not a secret, and generating one per test run would make
 * failures non-reproducible. This one corresponds to a private key that was
 * never written down.
 */
export const TEST_ASSERTION_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqhTKPgYZcYD7W+5YwSeqWoU5pvPY",
  "NzUmczh/KjOqC/j+HBJcp1MAJmcL9l79c6WMPZb8VxPkPBSX0asvdNYZhg==",
  "-----END PUBLIC KEY-----",
].join("\n");

/** The same key as the single-line base64 form deployments must use. */
export const TEST_ASSERTION_PUBLIC_KEY_B64 =
  "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemow" +
  "REFRY0RRZ0FFcWhUS1BnWVpjWUQ3Vys1WXdTZXFXb1U1cHZQWQpOelVtY3poL0tqT3FDL2or" +
  "SEJKY3AxTUFKbWNMOWw3OWM2V01QWmI4VnhQa1BCU1gwYXN2ZE5ZWmhnPT0KLS0tLS1FTkQg" +
  "UFVCTElDIEtFWS0tLS0tCg==";
