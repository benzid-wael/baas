import { describe, expect, it } from "vitest";
import { Instant } from "@baas/domain";
import { TestClock } from "../clock.js";
import { ConfigurationError, loadConfig } from "./load.js";
import { SECRET_ENV_KEYS } from "./secrets.js";
import { TEST_ASSERTION_PUBLIC_KEY_B64 } from "./fixtures.js";

const VALID_SECRET = "K7mQ2xR9vL4pT8wZ3nB6jH1sD5gF0aYc";

function devEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: "dev",
    DATABASE_PASSWORD: "local-development-password",
    MOBILE_ASSERTION_PUBLIC_KEY: TEST_ASSERTION_PUBLIC_KEY_B64,
    MOBILE_ASSERTION_ISSUER: "https://bff.dev.superchat.internal",
    MOBILE_ASSERTION_AUDIENCE: "baas",
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: VALID_SECRET,
    CALLBACK_HMAC_SECRET: VALID_SECRET,
    ...overrides,
  };
}

function hardenedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return devEnv({
    APP_ENV: "production",
    DATABASE_SSL: "true",
    DATABASE_MIGRATIONS_RUN: "true",
    THROTTLE_STORAGE: "redis",
    REDIS_URL: "redis://redis:6379",
    OPENAPI_ENABLED: "false",
    APM_SERVER_URL: "https://apm.nrml.tools",
    OIDC_ISSUER: "https://idp.example",
    OIDC_AUDIENCE: "baas-portal",
    OIDC_JWKS_URI: "https://idp.example/jwks",
    PROVIDERS: "keel",
    PROVIDER_KEEL_BASE_URL: "https://sandbox.keel.example",
    PROVIDER_KEEL_CLIENT_ID: "client",
    PROVIDER_KEEL_CLIENT_SECRET: "secret",
    ...overrides,
  });
}

function issuesFrom(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.issues.map((issue) => issue.path);
    }
    throw error;
  }
  throw new Error("expected loadConfig to reject this environment");
}

describe("loadConfig in dev", () => {
  it("loads with only the secrets supplied", () => {
    const config = loadConfig(devEnv());
    expect(config.global.appEnv).toBe("dev");
    expect(config.global.port).toBe(3000);
    expect(config.global.database.host).toBe("localhost");
    expect(config.global.openApiEnabled).toBe(true);
  });

  it("decodes the assertion key from its single-line base64 form", () => {
    const config = loadConfig(devEnv());
    expect(config.global.mobileAssertion.publicKey).toMatch(
      /^-----BEGIN PUBLIC KEY-----/,
    );
  });

  it("requires issuer and audience even in dev", () => {
    // The incumbent requires these in stage and production only, while the BFF
    // mints neither, so every mobile request 401s in stage and nowhere else.
    const missing = issuesFrom(
      devEnv({ MOBILE_ASSERTION_ISSUER: "", MOBILE_ASSERTION_AUDIENCE: "" }),
    );
    expect(missing).toContain("mobileAssertion.issuer");
    expect(missing).toContain("mobileAssertion.audience");
  });

  it("allows a tenant with no providers, because dev has nothing to call", () => {
    const config = loadConfig(devEnv());
    expect([...config.tenants.keys()]).toEqual(["superchat"]);
    expect(config.tenants.get("superchat")?.providers).toEqual({});
  });
});

describe("no secret has a default", () => {
  it.each(SECRET_ENV_KEYS)("%s is required, never defaulted", (key) => {
    const paths = issuesFrom(
      Object.fromEntries(
        Object.entries(devEnv()).filter(([name]) => name !== key),
      ),
    );
    expect(paths.length).toBeGreaterThan(0);
  });

  it("reports every missing secret at once from an empty environment", () => {
    const paths = issuesFrom({ APP_ENV: "dev" });
    expect(paths).toContain("database.password");
    expect(paths).toContain("providerCredentialEncryptionKey");
    expect(paths).toContain("callbackHmacSecret");
    expect(paths).toContain("mobileAssertion.publicKey");
  });
});

describe("the production contract", () => {
  it("loads a correctly hardened production environment", () => {
    const config = loadConfig(hardenedEnv());
    expect(config.global.appEnv).toBe("production");
    expect(config.global.database.ssl).toBe(true);
    expect(config.tenants.get("superchat")?.providers["keel"]?.baseUrl).toBe(
      "https://sandbox.keel.example",
    );
  });

  it("holds stage to the same contract as production", () => {
    const paths = issuesFrom({
      ...devEnv(),
      APP_ENV: "stage",
      PROVIDERS: "keel",
      PROVIDER_KEEL_BASE_URL: "https://x.example",
      PROVIDER_KEEL_CLIENT_ID: "c",
      PROVIDER_KEEL_CLIENT_SECRET: "s",
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "database.ssl",
        "throttle.storage",
        "openApiEnabled",
        "observability.apmServerUrl",
      ]),
    );
  });

  it("names every violated rule at once, not the first", () => {
    // The headline criterion: a deployment that breaks six rules must learn all
    // six from one boot, not from six restarts.
    const env = hardenedEnv({
      DATABASE_SSL: "false",
      DATABASE_MIGRATIONS_RUN: "false",
      THROTTLE_STORAGE: "memory",
      OPENAPI_ENABLED: "true",
      PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "changeme-changeme-changeme-change",
      APM_SERVER_URL: undefined,
    });

    let caught: ConfigurationError | undefined;
    try {
      loadConfig(env);
    } catch (error) {
      caught = error instanceof ConfigurationError ? error : undefined;
    }

    expect(caught).toBeDefined();
    expect(caught?.issues.map((issue) => issue.path)).toEqual([
      "database.ssl",
      "database.migrationsRun",
      "throttle.storage",
      "openApiEnabled",
      "observability.apmServerUrl",
      "providerCredentialEncryptionKey",
    ]);
    expect(caught?.message).toContain("6 problems");
  });

  it("requires an identity provider, because an operator console without one is open", () => {
    const paths = issuesFrom(
      hardenedEnv({
        OIDC_ISSUER: undefined,
        OIDC_AUDIENCE: undefined,
        OIDC_JWKS_URI: undefined,
      }),
    );
    expect(paths).toEqual(
      expect.arrayContaining(["oidc.issuer", "oidc.audience", "oidc.jwksUri"]),
    );
  });

  it("does not require one in dev, where the compose provider supplies it", () => {
    expect(() => loadConfig(devEnv())).not.toThrow();
  });

  it("parses the bootstrap admin list, and defaults it to empty", () => {
    expect(loadConfig(devEnv()).global.oidc.bootstrapAdminSubjects).toEqual([]);
    expect(
      loadConfig(devEnv({ OPERATOR_BOOTSTRAP_ADMIN_SUBJECTS: "a, b ,c" }))
        .global.oidc.bootstrapAdminSubjects,
    ).toEqual(["a", "b", "c"]);
  });

  it("refuses a placeholder secret in a hardened tier but not in dev", () => {
    const placeholder = "insecure-placeholder-value-for-dev!!";
    expect(
      issuesFrom(hardenedEnv({ CALLBACK_HMAC_SECRET: placeholder })),
    ).toContain("callbackHmacSecret");
    expect(() =>
      loadConfig(devEnv({ CALLBACK_HMAC_SECRET: placeholder })),
    ).not.toThrow();
  });

  it("still reports the tier contract when a field also fails validation", () => {
    // Regression: the contract used to run only on a successful parse, so one
    // short secret hid five other violations and produced a deployment that
    // learned one rule per restart.
    const paths = issuesFrom(
      hardenedEnv({
        CALLBACK_HMAC_SECRET: "short",
        DATABASE_SSL: "false",
        THROTTLE_STORAGE: "memory",
      }),
    );
    expect(paths).toContain("callbackHmacSecret");
    expect(paths).toContain("database.ssl");
    expect(paths).toContain("throttle.storage");
  });

  it("requires REDIS_URL once redis is selected", () => {
    expect(
      issuesFrom(
        hardenedEnv({ THROTTLE_STORAGE: "redis", REDIS_URL: undefined }),
      ),
    ).toContain("throttle.redisUrl");
  });

  it("refuses a placeholder database password outside dev", () => {
    expect(
      issuesFrom(hardenedEnv({ DATABASE_PASSWORD: "changeme" })),
    ).toContain("database.password");
  });

  it("reports a malformed provider under its own path", () => {
    expect(
      issuesFrom(hardenedEnv({ PROVIDER_KEEL_BASE_URL: "not-a-url" })),
    ).toContain("tenants.superchat.providers.keel.baseUrl");
  });

  it("requires at least one provider outside dev", () => {
    expect(issuesFrom(hardenedEnv({ PROVIDERS: "" }))).toContain(
      "tenants.superchat.providers",
    );
  });

  it("refuses an unknown tier outright", () => {
    expect(issuesFrom({ APP_ENV: "staging" })).toEqual(["appEnv"]);
  });
});

describe("feature flag expiry", () => {
  it("passes when no flag is declared, which is the correct resting state", () => {
    const clock = new TestClock(
      Instant.fromEpochMilliseconds(4_102_444_800_000),
    );
    expect(() => loadConfig(devEnv(), { clock })).not.toThrow();
  });
});
