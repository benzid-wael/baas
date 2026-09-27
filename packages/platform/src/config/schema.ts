import { z } from "zod";
import { APP_ENVS, isHardened } from "./app-env.js";
import type { AppEnv } from "./app-env.js";
import { isPem, normalizePem } from "./pem.js";
import { MIN_SECRET_LENGTH, looksLikePlaceholder } from "./secrets.js";

/**
 * Configuration is two schemas, not one (RFC-BaaS §4).
 *
 * `GlobalConfig` is the deployment: where the database is, which tier this is,
 * how it logs. `TenantConfig` is everything that varies per tenant — today
 * exactly one tenant, resolved from the environment; tomorrow many, resolved
 * from the `tenant` table (T6). Consumers take a `TenantConfig`, so moving the
 * source later changes one implementation rather than every call site.
 *
 * Keeping the split now costs a type. Introducing it after provider
 * credentials are read directly from `process.env` across the codebase costs
 * an audit of every read.
 */

/**
 * Defaults for the keys the tier contract asserts on.
 *
 * Shared by the schema and the contract so the two cannot disagree about what
 * an unset variable means — which would make the contract assert one thing and
 * the service run another.
 */
export const TIER_DEFAULTS = {
  DATABASE_SSL: false,
  DATABASE_MIGRATIONS_RUN: true,
  THROTTLE_STORAGE: "memory",
  OPENAPI_ENABLED: true,
} as const;

const booleanFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) =>
    typeof value === "boolean" ? value : value === "true" || value === "1",
  );

const port = z.coerce.number().int().min(1).max(65_535);

const secret = z
  .string()
  .min(
    MIN_SECRET_LENGTH,
    `must be at least ${MIN_SECRET_LENGTH.toString()} characters`,
  );

const pem = z
  .string()
  .min(1)
  .refine(isPem, "must be a PEM block, or single-line base64 of one")
  .transform(normalizePem);

export const databaseSchema = z.object({
  host: z.string().min(1).default("localhost"),
  port: port.default(5432),
  user: z.string().min(1).default("baas"),
  password: z.string().min(1),
  database: z.string().min(1).default("baas"),
  /** TLS in transit. The incumbent runs without it; that is a live finding. */
  ssl: booleanFromEnv.default(TIER_DEFAULTS.DATABASE_SSL),
  poolMax: z.coerce.number().int().min(1).max(100).default(10),
  /** Migrations are applied at boot. There is no `synchronize` here to disable. */
  migrationsRun: booleanFromEnv.default(TIER_DEFAULTS.DATABASE_MIGRATIONS_RUN),
});

export const observabilitySchema = z.object({
  serviceName: z.string().min(1).default("baas"),
  /**
   * Explicit per deployment. Elastic APM's own default is `dev`, and a service
   * that forgets to set this reports as dev and appears "missing from APM".
   * Derived from the tier rather than read separately, so it cannot disagree.
   */
  apmServerUrl: z.url().optional(),
});

export const mobileAssertionSchema = z.object({
  /**
   * Required in every tier, including dev.
   *
   * The incumbent requires issuer and audience in stage and production only,
   * while the BFF mints neither — so every mobile request 401s in stage and
   * production and nowhere else. Requiring them in dev makes the BFF change
   * cheap and forces it to happen where it is safe. T9 owns the verification
   * itself; this is the half that makes the failure impossible to defer.
   */
  publicKey: pem,
  issuer: z.string().min(1),
  audience: z.string().min(1),
});

/**
 * Operator sign-in.
 *
 * `issuer` and `jwksUri` are separate settings on purpose, and it is not
 * redundancy. The issuer is a **string compared** against a token's `iss`
 * claim; the JWKS URI is a **URL fetched**. In a container they differ: the
 * browser reaches the provider on the published port while the service
 * reaches it by compose name, and the token's `iss` is whatever the browser
 * saw. Collapsing them into one setting makes local sign-in impossible to
 * configure without lying about one of the two.
 */
export const oidcSchema = z.object({
  issuer: z.string().default(""),
  audience: z.string().default(""),
  jwksUri: z.string().default(""),
  /**
   * Subjects granted `admin` on first sign-in, once.
   *
   * Registration deliberately grants no role, so a fresh environment has
   * nobody who can grant one. **Seed two.** Finding C3: the incumbent
   * deadlocked policy publishing, payment-order approval and account-opening
   * review because an environment had a single administrator and dual control
   * needs two people.
   */
  bootstrapAdminSubjects: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((subject) => subject.trim())
        .filter((subject) => subject.length > 0),
    ),
});

export const throttleSchema = z.object({
  storage: z.enum(["memory", "redis"]).default(TIER_DEFAULTS.THROTTLE_STORAGE),
  redisUrl: z.url().optional(),
});

export const globalSchema = z.object({
  appEnv: z.enum(APP_ENVS),
  port: port.default(3000),
  bindHost: z.string().min(1).optional(),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  corsOrigins: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  openApiEnabled: booleanFromEnv.default(TIER_DEFAULTS.OPENAPI_ENABLED),
  database: databaseSchema,
  throttle: throttleSchema,
  observability: observabilitySchema,
  mobileAssertion: mobileAssertionSchema,
  oidc: oidcSchema,
  /** Encrypts provider credentials at rest (AES-256-GCM). */
  providerCredentialEncryptionKey: secret,
  /** Verifies inbound provider callbacks. */
  callbackHmacSecret: secret,
  bootstrapTenantSlug: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .default("superchat"),
});

export type GlobalConfig = z.infer<typeof globalSchema>;

export const providerCredentialsSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;

export const tenantSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  providers: z.record(z.string(), providerCredentialsSchema),
});

export type TenantConfig = z.infer<typeof tenantSchema>;

export interface Config {
  readonly global: GlobalConfig;
  readonly tenants: ReadonlyMap<string, TenantConfig>;
}

/**
 * The production contract, carried over from the incumbent before being
 * extended (RFC-BaaS §5.5).
 *
 * Asserted against the **environment**, not against the parsed configuration.
 *
 * That is deliberate, and it is a correction: the first version ran against the
 * parsed object and so was skipped entirely whenever any field failed
 * validation. A production deployment with one short secret learned nothing
 * about its five other violations — reintroducing exactly the one-rule-per-
 * restart failure this contract exists to prevent. These are assertions about
 * a manifest, so they read the manifest, and they always run.
 *
 * Every rule reports independently.
 */
export function applyTierContract(
  env: NodeJS.ProcessEnv,
  appEnv: AppEnv,
  addIssue: (path: readonly string[], message: string) => void,
): void {
  if (!isHardened(appEnv)) {
    return;
  }

  if (!boolFromEnv(env["DATABASE_SSL"], TIER_DEFAULTS.DATABASE_SSL)) {
    addIssue(
      ["database", "ssl"],
      `${appEnv} requires DATABASE_SSL=true; personal data must not cross the network in clear`,
    );
  }
  if (
    !boolFromEnv(
      env["DATABASE_MIGRATIONS_RUN"],
      TIER_DEFAULTS.DATABASE_MIGRATIONS_RUN,
    )
  ) {
    addIssue(
      ["database", "migrationsRun"],
      `${appEnv} requires DATABASE_MIGRATIONS_RUN=true; migrations are the only source of schema truth`,
    );
  }

  const storage = env["THROTTLE_STORAGE"] ?? TIER_DEFAULTS.THROTTLE_STORAGE;
  if (storage !== "redis") {
    addIssue(
      ["throttle", "storage"],
      `${appEnv} requires THROTTLE_STORAGE=redis; in-memory throttling does not survive more than one replica`,
    );
  } else if ((env["REDIS_URL"] ?? "") === "") {
    addIssue(
      ["throttle", "redisUrl"],
      "REDIS_URL is required when THROTTLE_STORAGE=redis",
    );
  }

  if (boolFromEnv(env["OPENAPI_ENABLED"], TIER_DEFAULTS.OPENAPI_ENABLED)) {
    addIssue(
      ["openApiEnabled"],
      `${appEnv} requires OPENAPI_ENABLED=false; the full API surface is not a public document`,
    );
  }
  for (const [key, path] of [
    ["OIDC_ISSUER", ["oidc", "issuer"]],
    ["OIDC_AUDIENCE", ["oidc", "audience"]],
    ["OIDC_JWKS_URI", ["oidc", "jwksUri"]],
  ] as const) {
    if ((env[key] ?? "") === "") {
      addIssue(
        path,
        `${appEnv} requires ${key}; an operator console without an identity provider is an open console`,
      );
    }
  }

  if ((env["APM_SERVER_URL"] ?? "") === "") {
    addIssue(
      ["observability", "apmServerUrl"],
      `${appEnv} requires APM_SERVER_URL; a service with no traces cannot be diagnosed`,
    );
  }

  for (const [path, key] of [
    [["providerCredentialEncryptionKey"], "PROVIDER_CREDENTIAL_ENCRYPTION_KEY"],
    [["callbackHmacSecret"], "CALLBACK_HMAC_SECRET"],
    [["database", "password"], "DATABASE_PASSWORD"],
  ] as const) {
    const value = env[key];
    if (value !== undefined && looksLikePlaceholder(value)) {
      addIssue(path, `${appEnv} refuses a placeholder value in ${key}`);
    }
  }
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1";
}
