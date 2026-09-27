import type { Kysely } from "kysely";
import type { AccountReadPort, Clock, IdGenerator } from "@baas/domain";
import type { Config, Logger } from "@baas/platform";
import {
  AccountRepository,
  ApiClientRepository,
  AuditRepository,
  BalanceRepository,
  CustomerRepository,
  OperatorRepository,
  TenantScope,
  TransactionRepository,
  assertSchemaMatches,
} from "@baas/persistence";
import type { Database } from "@baas/persistence";
import {
  CapabilityRegistry,
  OperatorReads,
  ReadAccounts,
  ReadBalance,
  ReadTransactions,
} from "@baas/application";
import type { ProviderAdapter, ProviderDeployment } from "@baas/application";
import { KNOWN_PROVIDERS, adaptersOf } from "@baas/provider-registry";
import type { ProviderBuildResult } from "@baas/provider-registry";
import { describeError, formatInstant } from "@baas/platform";
import type { CapabilityProvider } from "./system.controller.js";
import { RegistryApiClientLookup } from "./api-client-lookup.js";
import { RegistryCustomerLookup } from "./customer-lookup.js";
import type { ApiDependencies } from "./app.module.js";
import { JwksKeySource, OidcVerifier } from "./oidc.js";

/**
 * The object graph, built once (New-18).
 *
 * Until this file existed there was no assembled application: every test wired
 * its own subset, the `full` compose profile referenced a `main.js` that was
 * never built, and nothing anywhere constructed the whole thing. A composition
 * root is the one place allowed to know every concrete type, so that nothing
 * else has to.
 *
 * Two rules it keeps:
 *
 * - **Nothing here reads `process.env`.** It takes a parsed `Config`. Finding
 *   A8 is configuration read from the environment in fifty places; the cure is
 *   one reader and one graph, not a tidier fifty.
 * - **A provider with no adapter is reported, never guessed.** Adapters are
 *   built by `@baas/provider-registry`, which is the only layer that knows a
 *   provider by name; this file receives the results and turns them into one
 *   capability answer per provider.
 */
export interface ApiGraph {
  readonly dependencies: ApiDependencies;
  readonly scope: TenantScope;
  readonly tenantId: string;
}

export interface ComposeApiOptions {
  readonly config: Config;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The tenant this deployment serves. Resolved from the database by the
   * caller, because the configuration names a slug and the row carries the id.
   */
  readonly tenantId: string;
  /**
   * What `buildProviders` made of the configuration. Passed in rather than
   * built here so that a test can supply a fake without a real base URL, and
   * so that the API and the worker cannot disagree about what is configured.
   */
  readonly providers?: readonly ProviderBuildResult[];
}

export function composeApi(options: ComposeApiOptions): ApiGraph {
  const { config, db, logger, clock, ids, tenantId } = options;

  const scope = new TenantScope(db);
  const customers = new CustomerRepository(clock, ids);
  const accounts = new AccountRepository(clock, ids);
  const balances = new BalanceRepository(clock, ids);
  const transactions = new TransactionRepository();
  const audit = new AuditRepository(clock, ids);
  const apiClients = new ApiClientRepository();

  const providers = options.providers ?? [];
  const adapters = adaptersOf(providers);

  const readBalance = new ReadBalance(
    scope,
    balances,
    accountPortsOf(adapters),
    clock,
    logger,
  );

  const capabilities = new CapabilityRegistry({
    serviceName: config.global.observability.serviceName,
    appEnv: config.global.appEnv,
    adapters,
    supportedProviders: KNOWN_PROVIDERS,
    deployment: deploymentOf(config, providers),
    tenants: [...config.tenants.keys()],
    clock,
    formatInstant,
  });

  return {
    scope,
    tenantId,
    dependencies: {
      clients: new RegistryApiClientLookup(scope, apiClients),
      customers: new RegistryCustomerLookup(scope, customers),
      assertion: {
        publicKeyPem: config.global.mobileAssertion.publicKey,
        issuer: config.global.mobileAssertion.issuer,
        audience: config.global.mobileAssertion.audience,
      },
      capabilities: capabilityProvider(capabilities, db, logger),
      logger,
      reads: {
        accounts: new ReadAccounts(scope, accounts, readBalance),
        transactions: new ReadTransactions(scope, accounts, transactions),
        operator: new OperatorReads(
          scope,
          customers,
          accounts,
          transactions,
          readBalance,
          audit,
        ),
      },
      operatorSessions: {
        verifier: new OidcVerifier(
          {
            issuer: config.global.oidc.issuer,
            audience: config.global.oidc.audience,
          },
          new JwksKeySource(config.global.oidc.jwksUri, clock),
        ),
        operators: new OperatorRepository(clock, ids),
        scope,
        db,
        logger,
        tenantId,
        bootstrapAdminSubjects: config.global.oidc.bootstrapAdminSubjects,
      },
    },
  };
}

/**
 * What the deployment says about each declared provider.
 *
 * Finding A1: an adapter reported itself unavailable because it read an
 * environment variable the provider does not use. The adapter is not asked —
 * the build result is, and the capability registry composes that with the
 * ports the adapter supplies into one reason.
 *
 * A provider named in `PROVIDERS` that no factory recognises appears here as
 * unconfigured so that it is *visible*. Dropping it would make a typo in the
 * manifest indistinguishable from a provider nobody declared.
 */
function deploymentOf(
  config: Config,
  providers: readonly ProviderBuildResult[],
): ReadonlyMap<string, ProviderDeployment> {
  const built = new Map(
    providers.map((result) => [result.providerId, result.outcome.configured]),
  );
  const deployment = new Map<string, ProviderDeployment>();
  for (const tenant of config.tenants.values()) {
    for (const name of Object.keys(tenant.providers)) {
      deployment.set(name, { configured: built.get(name) ?? false });
    }
  }
  return deployment;
}

/**
 * The account-read ports, by provider id.
 *
 * Derived from the adapters rather than assembled beside them, for the same
 * reason capabilities are derived: a second list is a second thing to forget.
 */
function accountPortsOf(
  adapters: readonly ProviderAdapter[],
): ReadonlyMap<string, AccountReadPort> {
  return new Map(
    adapters.flatMap((adapter) =>
      adapter.accounts === undefined
        ? []
        : [[adapter.providerId, adapter.accounts] as const],
    ),
  );
}

/**
 * Readiness asserts the **schema**, not the migration ledger (finding C1).
 *
 * The incumbent reports healthy when a migration is recorded, even if its
 * statements did not apply — so a half-migrated database serves traffic. Here
 * readiness runs the same introspection the drift test runs, so "ready" means
 * the tables are the tables the code believes in.
 */
function capabilityProvider(
  capabilities: CapabilityRegistry,
  db: Kysely<Database>,
  logger: Logger,
): CapabilityProvider {
  return {
    capabilities: () => Promise.resolve(capabilities.report()),
    ready: async () => {
      const checks: Record<string, boolean> = {
        database: false,
        schema: false,
      };
      try {
        await db.selectFrom("tenant").select("id").limit(1).execute();
        checks["database"] = true;
        await assertSchemaMatches(db);
        checks["schema"] = true;
      } catch (error) {
        logger.error({ err: describeError(error) }, "readiness check failed");
      }
      return { ready: Object.values(checks).every(Boolean), checks };
    },
  };
}
