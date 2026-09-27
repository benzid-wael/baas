import { Duration } from "@baas/domain";
import type { Clock, IdGenerator, TransactionReadPort } from "@baas/domain";
import { adaptersOf } from "@baas/provider-registry";
import type { ProviderBuildResult } from "@baas/provider-registry";
import type { Logger } from "@baas/platform";
import {
  AccountRepository,
  ProviderRequestLogRepository,
  TenantScope,
  TransactionRepository,
} from "@baas/persistence";
import type { Kysely } from "kysely";
import type { Database } from "@baas/persistence";
import { Scheduler } from "./scheduler.js";
import type { Job } from "./scheduler.js";
import { TransactionProjector } from "./projector.js";
import type { ProjectableAccount } from "./projector.js";

/** How many accounts one projection pass walks. See `listForTenant`. */
const PROJECTION_PAGE = 200;

export interface WorkerOptions {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly tenantId: string;
  /**
   * What `buildProviders` made of the configuration. The same results the API
   * receives, so the two cannot disagree about what is configured.
   */
  readonly providers?: readonly ProviderBuildResult[];
  readonly projectEvery?: Duration;
  readonly purgeEvery?: Duration;
}

export interface WorkerHandle {
  readonly scheduler: Scheduler;
  readonly jobs: readonly Job[];
}

/**
 * The worker's object graph (New-18).
 *
 * **Only jobs whose collaborators exist are scheduled.** The dispatcher needs
 * a `ProviderDispatch` and the reconciler needs an event interpreter; neither
 * exists yet, because nothing writes. Scheduling them anyway would give a
 * worker that ticks and does nothing while looking like it works — which is
 * finding A8 in the incumbent, where three recovery crons defaulted to off and
 * a correctly deployed service was silently inert. A job that cannot run is
 * absent, not disabled.
 */
export function buildWorker(options: WorkerOptions): WorkerHandle {
  const scope = new TenantScope(options.db);
  const accounts = new AccountRepository(options.clock, options.ids);
  const transactions = new TransactionRepository();
  const providers = transactionPortsOf(options.providers ?? []);

  const requestLog = new ProviderRequestLogRepository();

  const projector = new TransactionProjector({
    scope,
    transactions,
    providers,
    logger: options.logger,
  });

  const jobs: Job[] = [];

  // With no adapter registered there is no provider to read from, so the job
  // is not scheduled rather than scheduled and failing every account.
  if (providers.size > 0) {
    jobs.push({
      name: "project-transactions",
      every: options.projectEvery ?? Duration.ofSeconds(60),
      run: async () => {
        const run = await projector.runOnce(
          await projectableAccounts(
            scope,
            accounts,
            options.tenantId,
            providers,
          ),
        );
        options.logger.info(
          {
            accounts: run.accounts,
            projected: run.projected,
            failed: run.failed,
          },
          "transaction projection pass complete",
        );
      },
    });
  }

  // **Retention runs, and it runs here** (MP-2, finding N2). The incumbent has
  // a retention routine that was written and never scheduled, which is the
  // same as not having one — worse, because it reads like having one. It is
  // unconditional: unlike the projector it needs no adapter, and a deployment
  // that holds provider bodies with nothing deleting them is the single worst
  // state this service can be in.
  jobs.push({
    name: "purge-provider-request-log",
    every: options.purgeEvery ?? Duration.ofMinutes(15),
    run: async () => {
      const deleted = await requestLog.purgeExpired(
        options.db,
        options.clock.now(),
      );
      if (deleted > 0) {
        options.logger.info(
          { deleted },
          "purged expired provider request log rows",
        );
      }
    },
  });

  return {
    jobs,
    scheduler: new Scheduler({
      clock: options.clock,
      logger: options.logger,
      jobs,
    }),
  };
}

/**
 * The transaction-read ports, by provider id.
 *
 * Derived from the adapters rather than listed beside them: an adapter with no
 * transaction port projects nothing, and saying so twice is one place to get
 * it wrong.
 */
function transactionPortsOf(
  results: readonly ProviderBuildResult[],
): ReadonlyMap<string, TransactionReadPort> {
  return new Map(
    adaptersOf(results).flatMap((adapter) =>
      adapter.transactions === undefined
        ? []
        : [[adapter.providerId, adapter.transactions] as const],
    ),
  );
}

/**
 * The accounts this pass can actually project.
 *
 * Filtered to providers with an adapter **before** the projector sees them:
 * `projectAccount` throws for an unregistered provider, and a warning per
 * account per minute forever is a log nobody reads.
 */
export async function projectableAccounts(
  scope: TenantScope,
  accounts: AccountRepository,
  tenantId: string,
  providers: ReadonlyMap<string, TransactionReadPort>,
): Promise<readonly ProjectableAccount[]> {
  const records = await scope.run(tenantId, (db) =>
    accounts.listForTenant(db, { limit: PROJECTION_PAGE }),
  );
  return records
    .filter((account) => providers.has(account.providerId))
    .map((account) => ({
      tenantId,
      accountId: account.id,
      providerId: account.providerId,
      accountReference: account.accountReference,
    }));
}
