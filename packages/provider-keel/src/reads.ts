import type {
  AccountReadPort,
  Clock,
  ProviderAccount,
  ProviderBalance,
  TransactionPage,
  TransactionReadPort,
} from "@baas/domain";
import type { KeelHttp } from "./http.js";
import { KeelApiError } from "./errors.js";
import { mapAccount, mapBalance, mapTransaction } from "./mapper.js";
import type { KeelAccountSummary, KeelTransactionSummary } from "./mapper.js";

const ACCOUNTS = "/api/baas/v2/accounts";
const TRANSACTIONS = "/api/baas/v2/transactions";

/**
 * Keel reads (M1-4).
 *
 * Reads only, and structurally so: this class has no reference to the outbox
 * and no way to reach one, so it cannot become a path that moves money. It
 * also has no repository — an adapter that needs a database row is not an
 * adapter, and the boundary gate refuses the import.
 */
export class KeelReads implements AccountReadPort, TransactionReadPort {
  constructor(
    private readonly http: KeelHttp,
    private readonly clock: Clock,
  ) {}

  async listAccounts(
    ownerReference: string,
  ): Promise<readonly ProviderAccount[]> {
    const body = await this.http.get<{ accounts?: KeelAccountSummary[] }>(
      ACCOUNTS,
      { query: { ownerId: ownerReference } },
    );
    return (body.accounts ?? []).map(mapAccount);
  }

  async getAccount(
    accountReference: string,
  ): Promise<ProviderAccount | undefined> {
    const summary = await this.fetchAccount(accountReference);
    return summary === undefined ? undefined : mapAccount(summary);
  }

  /**
   * Keel returns the balance on the account resource rather than separately,
   * so a balance read is an account read. Kept as its own method because the
   * caller's intent differs — and because a provider that separates them
   * later changes this file and nothing else.
   */
  async getBalance(
    accountReference: string,
  ): Promise<ProviderBalance | undefined> {
    const summary = await this.fetchAccount(accountReference);
    return summary === undefined
      ? undefined
      : mapBalance(summary, this.clock.now());
  }

  async listTransactions(request: {
    accountReference: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<TransactionPage> {
    const body = await this.http.get<{
      transactions?: KeelTransactionSummary[];
      nextCursor?: string | null;
    }>(TRANSACTIONS, {
      query: {
        accountId: request.accountReference,
        limit: request.limit,
        cursor: request.cursor,
      },
    });

    return {
      transactions: (body.transactions ?? []).map((summary) =>
        mapTransaction(summary, request.accountReference),
      ),
      nextCursor: body.nextCursor ?? undefined,
    };
  }

  /**
   * A 404 is an answer, not a failure.
   *
   * Every other status still throws: turning a 500 into `undefined` would
   * report "no such account" for an outage, and the caller would cache that
   * as absence.
   */
  private async fetchAccount(
    accountReference: string,
  ): Promise<KeelAccountSummary | undefined> {
    try {
      return await this.http.get<KeelAccountSummary>(
        `${ACCOUNTS}/${encodeURIComponent(accountReference)}`,
        // The reference goes in the path, so the log records the route.
        { operation: `GET ${ACCOUNTS}/{accountReference}` },
      );
    } catch (error) {
      if (error instanceof KeelApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }
}
