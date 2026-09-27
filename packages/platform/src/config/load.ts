import type { z } from "zod";
import { APP_ENVS, resolveAppEnv } from "./app-env.js";
import { FEATURE_FLAGS, findExpiredFlags } from "./flags.js";
import type { FeatureFlag } from "./flags.js";
import { applyTierContract, globalSchema, tenantSchema } from "./schema.js";
import type { Config, TenantConfig } from "./schema.js";
import type { Clock } from "@baas/domain";

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Every problem with the configuration, in one error.
 *
 * The incumbent's validator reports the first failure and stops, which turns a
 * misconfigured deployment into a sequence of restarts, each revealing one
 * more rule. Reporting all of them costs nothing and is the difference between
 * one fix and six.
 */
export class ConfigurationError extends Error {
  readonly code = "platform.config.invalid";

  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `Configuration is invalid (${issues.length.toString()} problem${
        issues.length === 1 ? "" : "s"
      }):\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

export interface LoadOptions {
  /**
   * Present only so the flag-expiry check is testable. Absent at boot means
   * the check does not run: a deployment should not fail because a clock
   * crossed midnight while it was starting.
   */
  readonly clock?: Clock;
  /**
   * Test seam. A test that needs an expired flag must be able to declare one
   * without adding it to the real registry, where it would then have to be
   * maintained forever.
   */
  readonly flags?: Readonly<Record<string, FeatureFlag>>;
}

/**
 * Read the environment into a typed configuration, or throw with everything
 * that is wrong. Called exactly once, at boot, before anything else starts.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: LoadOptions = {},
): Config {
  const issues: ConfigIssue[] = [];
  const addIssue = (path: readonly string[], message: string): void => {
    issues.push({ path: path.join("."), message });
  };

  const appEnv = resolveAppEnv(env);
  if (appEnv === undefined) {
    addIssue(
      ["appEnv"],
      `APP_ENV must be one of ${APP_ENVS.join(", ")} (received ${JSON.stringify(env["APP_ENV"])})`,
    );
    throw new ConfigurationError(issues);
  }

  const parsed = globalSchema.safeParse(shapeGlobal(env, appEnv));
  if (!parsed.success) {
    collectZodIssues(parsed.error, addIssue);
  }
  // Runs regardless of whether the schema parsed: a single bad field must not
  // hide the rest of the contract.
  applyTierContract(env, appEnv, addIssue);

  const tenants = shapeTenants(env, appEnv, addIssue);
  collectExpiredFlags(options.clock, options.flags ?? FEATURE_FLAGS, addIssue);

  if (issues.length > 0 || !parsed.success) {
    throw new ConfigurationError(issues);
  }

  return { global: parsed.data, tenants };
}

function collectZodIssues(
  error: z.ZodError,
  addIssue: (path: readonly string[], message: string) => void,
): void {
  for (const issue of error.issues) {
    addIssue(
      issue.path.map((segment) => String(segment)),
      issue.message,
    );
  }
}

function shapeGlobal(env: NodeJS.ProcessEnv, appEnv: string): unknown {
  return {
    appEnv,
    port: env["PORT"],
    bindHost: env["BIND_HOST"],
    logLevel: env["LOG_LEVEL"],
    corsOrigins: env["CORS_ORIGINS"],
    openApiEnabled: env["OPENAPI_ENABLED"],
    database: {
      host: env["DATABASE_HOST"],
      port: env["DATABASE_PORT"],
      user: env["DATABASE_USER"],
      password: env["DATABASE_PASSWORD"],
      database: env["DATABASE_NAME"],
      ssl: env["DATABASE_SSL"],
      poolMax: env["DATABASE_POOL_MAX"],
      migrationsRun: env["DATABASE_MIGRATIONS_RUN"],
    },
    throttle: {
      storage: env["THROTTLE_STORAGE"],
      redisUrl: env["REDIS_URL"],
    },
    observability: {
      serviceName: env["SERVICE_NAME"],
      apmServerUrl: env["APM_SERVER_URL"],
    },
    mobileAssertion: {
      publicKey: env["MOBILE_ASSERTION_PUBLIC_KEY"],
      issuer: env["MOBILE_ASSERTION_ISSUER"],
      audience: env["MOBILE_ASSERTION_AUDIENCE"],
    },
    oidc: {
      issuer: env["OIDC_ISSUER"],
      audience: env["OIDC_AUDIENCE"],
      jwksUri: env["OIDC_JWKS_URI"],
      bootstrapAdminSubjects: env["OPERATOR_BOOTSTRAP_ADMIN_SUBJECTS"],
    },
    providerCredentialEncryptionKey: env["PROVIDER_CREDENTIAL_ENCRYPTION_KEY"],
    callbackHmacSecret: env["CALLBACK_HMAC_SECRET"],
    bootstrapTenantSlug: env["BOOTSTRAP_TENANT_SLUG"],
  };
}

/**
 * Today there is one tenant and it comes from the environment. When the
 * `tenant` table exists (T6) this function is replaced by a database-backed
 * source; nothing that consumes a `TenantConfig` changes.
 *
 * Providers are declared as a list and read generically, so adding one is a
 * manifest change rather than a schema change.
 */
function shapeTenants(
  env: NodeJS.ProcessEnv,
  appEnv: string,
  addIssue: (path: readonly string[], message: string) => void,
): ReadonlyMap<string, TenantConfig> {
  const slug = env["BOOTSTRAP_TENANT_SLUG"] ?? "superchat";
  const declared = (env["PROVIDERS"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const providers: Record<string, unknown> = {};
  for (const name of declared) {
    const prefix = `PROVIDER_${name.toUpperCase().replace(/-/g, "_")}`;
    // Read generically from a computed prefix, so adding a provider is a
    // manifest change rather than a code change. The provider-specific keys
    // are optional here and validated by the registry, which is the only place
    // that knows which of them a given adapter requires (New-19).
    providers[name] = {
      provider: name,
      baseUrl: env[`${prefix}_BASE_URL`],
      clientId: env[`${prefix}_CLIENT_ID`],
      clientSecret: env[`${prefix}_CLIENT_SECRET`],
      httpTimeoutMs: env[`${prefix}_HTTP_TIMEOUT_MS`],
      accessTokenEndpoint: env[`${prefix}_ACCESS_TOKEN_ENDPOINT`],
      signingPrivateKeyPem: env[`${prefix}_SIGNING_PRIVATE_KEY`],
      bearerToken: env[`${prefix}_BEARER_TOKEN`],
      entity: env[`${prefix}_ENTITY`],
      languageCode: env[`${prefix}_LANGUAGE_CODE`],
      userId: env[`${prefix}_USER_ID`],
      channelId: env[`${prefix}_CHANNEL_ID`],
      tokenRefreshBufferSeconds: env[`${prefix}_TOKEN_REFRESH_BUFFER_SECONDS`],
      maxRetries: env[`${prefix}_MAX_RETRIES`],
    };
  }

  const parsed = tenantSchema.safeParse({
    slug,
    displayName: env["BOOTSTRAP_TENANT_NAME"] ?? slug,
    providers,
  });

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      addIssue(
        ["tenants", slug, ...issue.path.map((segment) => String(segment))],
        issue.message,
      );
    }
    return new Map();
  }

  if (appEnv !== "dev" && declared.length === 0) {
    addIssue(
      ["tenants", slug, "providers"],
      `${appEnv} requires PROVIDERS to name at least one provider; a tenant with no provider can hold no money`,
    );
  }

  return new Map([[slug, parsed.data]]);
}

/**
 * A flag past its declared expiry fails the load, and therefore CI.
 *
 * This is the teeth on the owner-and-expiry rule. The escape hatch is to move
 * the date, which leaves a dated line in the diff explaining why the flag
 * outlived its purpose — which is exactly the conversation that never happened
 * for the incumbent's 31 flags.
 */
function collectExpiredFlags(
  clock: Clock | undefined,
  flags: Readonly<Record<string, FeatureFlag>>,
  addIssue: (path: readonly string[], message: string) => void,
): void {
  if (clock === undefined) {
    return;
  }
  const expired = findExpiredFlags(flags, clock.now());
  for (const { name, flag } of expired) {
    addIssue(
      ["flags", name],
      `expired on ${flag.expires} and is owned by ${flag.owner}: remove it, or move the date and say why`,
    );
  }
}
