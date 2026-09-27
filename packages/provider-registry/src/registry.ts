import type { Clock } from "@baas/domain";
import type { ProviderCredentials } from "@baas/platform";
import type { ProviderAdapter } from "@baas/application";
import { KeelAccessTokens, KeelHttp, KeelReads } from "@baas/provider-keel";
import { RuyaHttp, RuyaReads, RuyaStatements } from "@baas/provider-ruya";

/**
 * Configuration in, adapters out (New-19).
 *
 * This package exists for one reason: `apps/api` and `apps/worker` both need
 * adapters built from the same settings, and two copies of a wiring rule drift
 * apart. It is the only layer allowed to know a provider by name.
 *
 * **An adapter never decides its own availability.** Finding A1: Keel's
 * adapter in the incumbent reported itself unavailable because it read an
 * environment variable the provider does not use, `bank_account` silently
 * vanished from routing, and hours went into the policy layer for a defect in
 * the adapter. Here the factory declares what it *requires*, this file checks
 * it, and an incomplete provider becomes a `not_configured` reason rather than
 * an adapter that exists and does not work.
 */
export type ProviderOutcome =
  | { readonly configured: true; readonly adapter: ProviderAdapter }
  | { readonly configured: false; readonly missing: readonly string[] };

export interface ProviderBuildResult {
  readonly providerId: string;
  readonly outcome: ProviderOutcome;
}

export interface BuildProvidersOptions {
  readonly providers: Readonly<Record<string, ProviderCredentials>>;
  readonly clock: Clock;
  /** Injectable so a test can build a real adapter without a real bank. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A factory, and the settings it cannot do without.
 *
 * `requires` is declared **beside** the code that uses those settings, so a
 * factory that starts needing a new one and forgets to list it is a change in
 * one file rather than a mismatch across two.
 */
interface ProviderFactory {
  readonly requires: readonly (keyof ProviderCredentials)[];
  build(
    credentials: ProviderCredentials,
    clock: Clock,
    fetchImpl: typeof fetch,
  ): ProviderAdapter;
}

const FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  keel: {
    // Without the signing key every non-GET is rejected, and Keel's rejection
    // message says nothing about signatures — so a deployment missing it looks
    // like a permissions problem for as long as anyone is prepared to look.
    requires: ["accessTokenEndpoint", "signingPrivateKeyPem"],
    build(credentials, clock, fetchImpl) {
      const http = new KeelHttp(
        {
          baseUrl: credentials.baseUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          accessTokenEndpoint: credentials.accessTokenEndpoint ?? "",
          signingPrivateKeyPem: credentials.signingPrivateKeyPem ?? "",
          httpTimeoutMs: credentials.httpTimeoutMs,
          ...(credentials.bearerToken === undefined
            ? {}
            : { bearerToken: credentials.bearerToken }),
        },
        new KeelAccessTokens(clock, fetchImpl),
        fetchImpl,
      );
      const reads = new KeelReads(http, clock);
      // Capabilities are derived from the ports supplied, never declared
      // beside them (finding N3): Keel has no statement port, so it claims no
      // statement capability, and it cannot claim one without one.
      return { providerId: "keel", accounts: reads, transactions: reads };
    },
  },
  ruya: {
    // TCS BaNCS demands all four on every call and answers unhelpfully
    // without them.
    requires: ["entity", "languageCode", "userId", "channelId"],
    build(credentials, clock, fetchImpl) {
      const http = new RuyaHttp(
        {
          baseUrl: credentials.baseUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          entity: credentials.entity ?? "",
          languageCode: credentials.languageCode ?? 0,
          userId: credentials.userId ?? 0,
          channelId: credentials.channelId ?? 0,
          httpTimeoutMs: credentials.httpTimeoutMs,
          tokenRefreshBufferSeconds: credentials.tokenRefreshBufferSeconds,
          maxRetries: credentials.maxRetries,
        },
        clock,
        fetchImpl,
      );
      const reads = new RuyaReads(http, clock);
      return {
        providerId: "ruya",
        accounts: reads,
        transactions: reads,
        statements: new RuyaStatements(http),
      };
    },
  },
};

/** Provider ids this build knows how to construct. */
export const KNOWN_PROVIDERS = Object.keys(FACTORIES).sort();

/**
 * Build every declared provider, reporting the ones that could not be built
 * and why.
 *
 * A provider named in `PROVIDERS` with no factory here is **not** an error at
 * this layer — it is `adapter_absent`, which the capability registry already
 * reports, and which is the honest answer for a provider this build predates.
 */
export function buildProviders(
  options: BuildProvidersOptions,
): readonly ProviderBuildResult[] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: ProviderBuildResult[] = [];

  for (const [providerId, credentials] of Object.entries(options.providers)) {
    const factory = FACTORIES[providerId];
    if (factory === undefined) {
      continue;
    }
    const missing = factory.requires.filter(
      (field) => credentials[field] === undefined,
    );
    results.push({
      providerId,
      outcome:
        missing.length > 0
          ? { configured: false, missing }
          : {
              configured: true,
              adapter: factory.build(credentials, options.clock, fetchImpl),
            },
    });
  }

  return results.sort((left, right) =>
    left.providerId.localeCompare(right.providerId),
  );
}

/** The adapters that were actually built. */
export function adaptersOf(
  results: readonly ProviderBuildResult[],
): readonly ProviderAdapter[] {
  return results.flatMap((result) =>
    result.outcome.configured ? [result.outcome.adapter] : [],
  );
}

export class IncompleteProviderError extends Error {
  readonly code = "platform.provider.incomplete";

  constructor(readonly problems: readonly ProviderBuildResult[]) {
    super(
      `A declared provider is incompletely configured:\n${problems
        .map((problem) =>
          problem.outcome.configured
            ? ""
            : `  - ${problem.providerId} is missing ${problem.outcome.missing.join(", ")}`,
        )
        .filter((line) => line !== "")
        .join("\n")}`,
    );
    this.name = "IncompleteProviderError";
  }
}

/**
 * Refuse to start a hardened tier with a half-configured provider.
 *
 * Dev tolerates one and says `not_configured` in the capability report, which
 * is how a developer works on one provider without credentials for the other.
 * Stage and production do not, because the failure mode there is finding A8:
 * a correctly deployed service that is silently inert, discovered by a
 * customer rather than by a deploy.
 */
export function refuseIncompleteProviders(
  appEnv: string,
  results: readonly ProviderBuildResult[],
): void {
  if (appEnv === "dev") {
    return;
  }
  const problems = results.filter((result) => !result.outcome.configured);
  if (problems.length > 0) {
    throw new IncompleteProviderError(problems);
  }
}
