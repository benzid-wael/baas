import type { TransactionReadPort } from "@baas/domain";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type {
  ProjectedTransaction,
  TenantScope,
  TransactionRepository,
} from "@baas/persistence";

/**
 * The transaction projector (M1-6).
 *
 * The single writer of the read model. It is a scheduled job on the shared
 * scheduler, and **it is not behind a feature flag** — a projection that is
 * switched off is a read surface that silently serves nothing, which is
 * finding A8's shape (`ORCHESTRATION_HISTORY_REFRESH_ENABLED`, defaulting
 * false, so a correctly deployed service sat inert).
 */
export interface ProjectableAccount {
  readonly tenantId: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly accountReference: string;
}

export interface ProjectorOptions {
  readonly scope: TenantScope;
  readonly transactions: TransactionRepository;
  readonly providers: ReadonlyMap<string, TransactionReadPort>;
  readonly logger: Logger;
  readonly pageSize?: number;
  /** Pages per account per run, so one busy account cannot starve the rest. */
  readonly maxPages?: number;
}

export interface ProjectionRun {
  readonly accounts: number;
  readonly projected: number;
  readonly failed: number;
}

export class TransactionProjector {
  constructor(private readonly options: ProjectorOptions) {}

  /**
   * Project one account's transactions.
   *
   * `rebuild` clears first. A projection you cannot rebuild is a projection
   * you cannot fix, so the operation exists from the first day rather than
   * being added after the first time it is needed.
   */
  async projectAccount(
    account: ProjectableAccount,
    options: { rebuild?: boolean } = {},
  ): Promise<number> {
    const provider = this.options.providers.get(account.providerId);
    if (provider === undefined) {
      throw new Error(
        `no adapter registered for provider "${account.providerId}"`,
      );
    }

    if (options.rebuild === true) {
      await this.options.scope.runAsProjector(account.tenantId, (db) =>
        this.options.transactions.clearAccount(db, account.accountId),
      );
    }

    const pageSize = this.options.pageSize ?? 100;
    const maxPages = this.options.maxPages ?? 20;
    let cursor: string | undefined;
    let projected = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await provider.listTransactions({
        accountReference: account.accountReference,
        cursor,
        limit: pageSize,
      });

      const rows: ProjectedTransaction[] = result.transactions.map(
        (transaction) => ({
          providerId: account.providerId,
          transactionReference: transaction.transactionReference,
          accountId: account.accountId,
          direction: transaction.direction,
          amount: transaction.amount,
          status: transaction.status,
          counterpartyName: transaction.counterpartyName,
          narrative: transaction.narrative,
          occurredAt: transaction.occurredAt,
        }),
      );

      if (rows.length > 0) {
        await this.options.scope.runAsProjector(account.tenantId, (db) =>
          this.options.transactions.project(db, account.tenantId, rows),
        );
        projected += rows.length;
      }

      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    return projected;
  }

  /**
   * One account failing must not stop the rest.
   *
   * A projector that aborts the run on the first bad account leaves every
   * account after it in the list stale, and the staleness is invisible.
   */
  async runOnce(
    accounts: readonly ProjectableAccount[],
  ): Promise<ProjectionRun> {
    let projected = 0;
    let failed = 0;

    for (const account of accounts) {
      try {
        projected += await this.projectAccount(account);
      } catch (error) {
        failed += 1;
        this.options.logger.warn(
          {
            accountId: account.accountId,
            providerId: account.providerId,
            err: describeError(error),
          },
          "could not project an account's transactions",
        );
      }
    }

    return { accounts: accounts.length, projected, failed };
  }
}
