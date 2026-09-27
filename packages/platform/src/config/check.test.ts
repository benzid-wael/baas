import { describe, expect, it } from "vitest";
import { checkConfig } from "./check.js";
import { TEST_ASSERTION_PUBLIC_KEY_B64 } from "./fixtures.js";

const VALID_SECRET = "K7mQ2xR9vL4pT8wZ3nB6jH1sD5gF0aYc";

const DEV_ENV: NodeJS.ProcessEnv = {
  APP_ENV: "dev",
  DATABASE_PASSWORD: "local-development-password",
  MOBILE_ASSERTION_PUBLIC_KEY: TEST_ASSERTION_PUBLIC_KEY_B64,
  MOBILE_ASSERTION_ISSUER: "https://bff.local",
  MOBILE_ASSERTION_AUDIENCE: "baas",
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: VALID_SECRET,
  CALLBACK_HMAC_SECRET: VALID_SECRET,
};

function run(env: NodeJS.ProcessEnv): { code: number; output: string } {
  const lines: string[] = [];
  const code = checkConfig(env, (line) => lines.push(line));
  return { code, output: lines.join("\n") };
}

describe("checkConfig", () => {
  it("exits zero and says which tier it validated", () => {
    const { code, output } = run(DEV_ENV);
    expect(code).toBe(0);
    expect(output).toContain("APP_ENV=dev");
    expect(output).toContain("1 tenant");
  });

  it("exits non-zero and names every violated rule", () => {
    const { code, output } = run({
      ...DEV_ENV,
      APP_ENV: "production",
      PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "changeme-changeme-changeme-change",
      OIDC_ISSUER: "https://idp.example",
      OIDC_AUDIENCE: "baas-portal",
      OIDC_JWKS_URI: "https://idp.example/jwks",
      PROVIDERS: "keel",
      PROVIDER_KEEL_BASE_URL: "https://keel.example",
      PROVIDER_KEEL_CLIENT_ID: "c",
      PROVIDER_KEEL_CLIENT_SECRET: "s",
    });

    expect(code).toBe(1);
    expect(output).toContain("5 problems");
    for (const rule of [
      "database.ssl",
      "throttle.storage",
      "openApiEnabled",
      "observability.apmServerUrl",
      "providerCredentialEncryptionKey",
    ]) {
      expect(output).toContain(rule);
    }
  });
});
