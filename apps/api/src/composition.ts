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
 * - **A provider with no adapter is reported, never guessed.** The adapter map
 *   is empty today and the capability report says `adapter_absent` for
 *   everything, which is the truth. Wiring Keel and Ruya from configuration is
 *   New-19, and it changes this file and nothing else.
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
   * Provider adapters, by provider id. Empty until New-19; passed in rather
   * than built here so that a test can supply a fake without a real base URL.
   */
  readonly adapters?: readonly ProviderAdapter[];
  readonly accountPorts?: ReadonlyMap<string, AccountReadPort>;
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

  const readBalance = new ReadBalance(
    scope,
    balances,
    options.accountPorts ?? new Map(),
    clock,
    logger,
  );

  const capabilities = new CapabilityRegistry({
    serviceName: config.global.observability.serviceName,
    appEnv: config.global.appEnv,
    adapters: options.adapters ?? [],
    deployment: deploymentOf(config),
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
 * the configuration is, here, and the registry composes the two answers into
 * one reason.
 */
function deploymentOf(config: Config): ReadonlyMap<string, ProviderDeployment> {
  const deployment = new Map<string, ProviderDeployment>();
  for (const tenant of config.tenants.values()) {
    for (const [name, credentials] of Object.entries(tenant.providers)) {
      deployment.set(name, {
        configured:
          credentials.baseUrl !== "" &&
          credentials.clientId !== "" &&
          credentials.clientSecret !== "",
      });
    }
  }
  return deployment;
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
