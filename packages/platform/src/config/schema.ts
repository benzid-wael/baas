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
 * What a hardened tier demands, as a list (New-9).
 *
 * One declaration per rule. The contract is a loop over this and the schema's
 * defaults are derived from it, so a rule cannot exist in one place and not
 * the other — which was the duplication: the schema knew the shape, the
 * contract knew the requirement, and a rule added to one and not the other is
 * simply not enforced, silently.
 *
 * **Deliberately a table and not a generator.** It would be possible to build
 * the whole `globalSchema` from this, and the result would be a configuration
 * nobody could read. What production demands has to stay legible as a list;
 * the schema keeps its own shapes, and only the defaults and the requirements
 * come from here.
 *
 * `because` is not decoration. A refusal that says "DATABASE_SSL must be true"
 * gets argued with at 2am; one that says why does not.
 */
export type TierRule =
  | {
      readonly kind: "boolean";
      readonly envKey: string;
      readonly path: readonly string[];
      readonly mustBe: boolean;
      readonly fallback: boolean;
      readonly because: string;
    }
  | {
      readonly kind: "literal";
      readonly envKey: string;
      readonly path: readonly string[];
      readonly mustBe: string;
      readonly fallback: string;
      readonly because: string;
    }
  | {
      readonly kind: "present";
      readonly envKey: string;
      readonly path: readonly string[];
      readonly because: string;
    }
  | {
      readonly kind: "presentWhen";
      readonly envKey: string;
      readonly path: readonly string[];
      /** Only required when another key holds this value. */
      readonly when: { readonly envKey: string; readonly equals: string };
      readonly because: string;
    }
  | {
      readonly kind: "noPlaceholder";
      readonly envKey: string;
      readonly path: readonly string[];
      readonly because: string;
    };

export const TIER_RULES: readonly TierRule[] = [
  {
    kind: "boolean",
    envKey: "DATABASE_SSL",
    path: ["database", "ssl"],
    mustBe: true,
    fallback: false,
    because: "personal data must not cross the network in clear",
  },
  {
    kind: "boolean",
    envKey: "DATABASE_MIGRATIONS_RUN",
    path: ["database", "migrationsRun"],
    mustBe: true,
    fallback: true,
    because: "migrations are the only source of schema truth",
  },
  {
    kind: "literal",
    envKey: "THROTTLE_STORAGE",
    path: ["throttle", "storage"],
    mustBe: "redis",
    fallback: "memory",
    because: "in-memory throttling does not survive more than one replica",
  },
  {
    kind: "presentWhen",
    envKey: "REDIS_URL",
    path: ["throttle", "redisUrl"],
    when: { envKey: "THROTTLE_STORAGE", equals: "redis" },
    because: "redis throttling needs somewhere to count",
  },
  {
    kind: "boolean",
    envKey: "OPENAPI_ENABLED",
    path: ["openApiEnabled"],
    mustBe: false,
    fallback: true,
    because: "the full API surface is not a public document",
  },
  {
    kind: "present",
    envKey: "OIDC_ISSUER",
    path: ["oidc", "issuer"],
    because:
      "an operator console without an identity provider is an open console",
  },
  {
    kind: "present",
    envKey: "OIDC_AUDIENCE",
    path: ["oidc", "audience"],
    because:
      "an operator console without an identity provider is an open console",
  },
  {
    kind: "present",
    envKey: "OIDC_JWKS_URI",
    path: ["oidc", "jwksUri"],
    because:
      "an operator console without an identity provider is an open console",
  },
  {
    kind: "present",
    envKey: "APM_SERVER_URL",
    path: ["observability", "apmServerUrl"],
    because: "a service with no traces cannot be diagnosed",
  },
  {
    kind: "noPlaceholder",
    envKey: "PROVIDER_CREDENTIAL_ENCRYPTION_KEY",
    path: ["providerCredentialEncryptionKey"],
    because: "it encrypts provider credentials at rest",
  },
  {
    kind: "noPlaceholder",
    envKey: "DATABASE_PASSWORD",
    path: ["database", "password"],
    because: "it is the database password",
  },
];

/**
 * Defaults for the keys the tier contract asserts on, **derived** from the
 * rules above rather than written beside them.
 *
 * Shared by the schema and the contract so the two cannot disagree about what
 * an unset variable means — which would make the contract assert one thing and
 * the service run another.
 */
export const TIER_DEFAULTS: Readonly<Record<string, boolean | string>> =
  Object.fromEntries(
    TIER_RULES.flatMap((rule) =>
      rule.kind === "boolean" || rule.kind === "literal"
        ? [[rule.envKey, rule.fallback]]
        : [],
    ),
  );

/**
 * The default for a key, read from the rule that governs it.
 *
 * Throws **at module load** when there is no such rule, which makes the
 * duplication New-9 was about impossible rather than merely tested: a schema
 * field cannot take a tier default unless a tier rule exists for it, and the
 * service refuses to start otherwise. A test could only have noticed.
 */
function tierDefault(envKey: string, kind: "boolean"): boolean;
function tierDefault(envKey: string, kind: "literal"): string;
function tierDefault(
  envKey: string,
  kind: "boolean" | "literal",
): boolean | string {
  const rule = TIER_RULES.find((candidate) => candidate.envKey === envKey);
  if (rule === undefined || rule.kind !== kind) {
    throw new Error(
      `No ${kind} tier rule for ${envKey}. A schema default and a tier requirement are one declaration (New-9); add the rule to TIER_RULES.`,
    );
  }
  return rule.fallback;
}

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
  ssl: booleanFromEnv.default(tierDefault("DATABASE_SSL", "boolean")),
  poolMax: z.coerce.number().int().min(1).max(100).default(10),
  /** Migrations are applied at boot. There is no `synchronize` here to disable. */
  migrationsRun: booleanFromEnv.default(
    tierDefault("DATABASE_MIGRATIONS_RUN", "boolean"),
  ),
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
  storage: z
    .enum(["memory", "redis"])
    .default(tierDefault("THROTTLE_STORAGE", "literal") as "memory" | "redis"),
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
  openApiEnabled: booleanFromEnv.default(
    tierDefault("OPENAPI_ENABLED", "boolean"),
  ),
  database: databaseSchema,
  throttle: throttleSchema,
  observability: observabilitySchema,
  mobileAssertion: mobileAssertionSchema,
  oidc: oidcSchema,
  /** Encrypts provider credentials at rest (AES-256-GCM). */
  providerCredentialEncryptionKey: secret,
  bootstrapTenantSlug: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .default("superchat"),
});

export type GlobalConfig = z.infer<typeof globalSchema>;

/**
 * A provider's settings (New-19).
 *
 * Four fields are common to every provider and the rest are provider-specific
 * optionals. That flatness is deliberate, and it is the *second* choice: the
 * first was a discriminated union keyed on the provider name, which puts a
 * list of known providers in the platform layer and makes adding one a schema
 * change rather than a manifest change.
 *
 * The schema therefore does not know that Keel needs a signing key and Ruya
 * needs an entity. **The provider registry does**, declares it beside the
 * factory that needs it, and reports a missing one as `not_configured` — which
 * is finding A1's rule: an adapter must not decide its own availability, the
 * registry composes configuration and capability into one answer.
 *
 * Dev tolerates an incomplete provider and says so in the capability report.
 * Stage and production refuse to start; see `refuseIncompleteProviders`.
 */
export const providerCredentialsSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /**
   * Every provider call is bounded. A read with no timeout is a read that can
   * hold a request open until the client gives up, and the incumbent's balance
   * reads have no ceiling at all.
   */
  httpTimeoutMs: z.coerce.number().int().min(100).max(120_000).default(10_000),

  // -- Keel ----------------------------------------------------------------
  /** Keel's OAuth token endpoint. Separate from `baseUrl`: they differ. */
  accessTokenEndpoint: z.url().optional(),
  /** PEM for the RSA request signature. Single-line base64 is decoded here. */
  signingPrivateKeyPem: pem.optional(),
  /** A pre-issued token, for a sandbox that does not run OAuth. */
  bearerToken: z.string().min(1).optional(),

  // -- Ruya (TCS BaNCS) ----------------------------------------------------
  /**
   * BaNCS demands these four on every call and answers unhelpfully without
   * them, which is why they are settings rather than constants: getting one
   * wrong produces an error that mentions none of them.
   */
  entity: z.string().min(1).optional(),
  languageCode: z.coerce.number().int().optional(),
  userId: z.coerce.number().int().optional(),
  channelId: z.coerce.number().int().optional(),
  tokenRefreshBufferSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600)
    .default(60),
  maxRetries: z.coerce.number().int().min(0).max(5).default(2),

  // -- inbound callbacks ---------------------------------------------------
  /**
   * How this provider's callbacks are authenticated (New-21).
   *
   * These replaced a single global `CALLBACK_HMAC_SECRET`, which could not
   * work: Keel signs with a private key and we verify with its **public key**,
   * while Ruya signs with a **shared secret**. Those are not the same kind of
   * thing, and one setting holding either would have to be interpreted
   * differently per provider — the ambiguity that makes a credential get
   * pasted into the wrong slot.
   */
  webhookPublicKeyPem: pem.optional(),
  callbackHmacSecret: secret.optional(),
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

  // One pass over the rules. Every rule reports independently — the contract
  // exists so a deployment learns all of its problems at once rather than one
  // per restart, and a loop that stopped at the first would reintroduce
  // exactly that.
  for (const rule of TIER_RULES) {
    const value = env[rule.envKey];

    switch (rule.kind) {
      case "boolean": {
        if (boolFromEnv(value, rule.fallback) !== rule.mustBe) {
          addIssue(
            rule.path,
            `${appEnv} requires ${rule.envKey}=${String(rule.mustBe)}; ${rule.because}`,
          );
        }
        break;
      }
      case "literal": {
        if ((value ?? rule.fallback) !== rule.mustBe) {
          addIssue(
            rule.path,
            `${appEnv} requires ${rule.envKey}=${rule.mustBe}; ${rule.because}`,
          );
        }
        break;
      }
      case "present": {
        if ((value ?? "") === "") {
          addIssue(
            rule.path,
            `${appEnv} requires ${rule.envKey}; ${rule.because}`,
          );
        }
        break;
      }
      case "presentWhen": {
        const governing =
          env[rule.when.envKey] ?? TIER_DEFAULTS[rule.when.envKey] ?? undefined;
        if (governing === rule.when.equals && (value ?? "") === "") {
          addIssue(
            rule.path,
            `${rule.envKey} is required when ${rule.when.envKey}=${rule.when.equals}; ${rule.because}`,
          );
        }
        break;
      }
      case "noPlaceholder": {
        if (value !== undefined && looksLikePlaceholder(value)) {
          addIssue(
            rule.path,
            `${appEnv} refuses a placeholder value in ${rule.envKey}; ${rule.because}`,
          );
        }
        break;
      }
    }
  }

  // Provider secrets are named per provider, so the placeholder rule has to be
  // generic. It was previously written out key by key, which meant a new
  // secret was unprotected until somebody remembered to add a line.
  for (const key of Object.keys(env)) {
    if (
      !/^PROVIDER_[A-Z0-9_]+_(CLIENT_SECRET|CALLBACK_HMAC_SECRET)$/.test(key)
    ) {
      continue;
    }
    const value = env[key];
    if (value !== undefined && looksLikePlaceholder(value)) {
      addIssue(
        ["tenants", "providers", key],
        `${appEnv} refuses a placeholder value in ${key}`,
      );
    }
  }
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1";
}
