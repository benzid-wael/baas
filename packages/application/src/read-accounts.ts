import type { BalanceView } from "@baas/domain";
import type {
  AccountRecord,
  AccountRepository,
  TenantScope,
  TransactionPageResult,
  TransactionRepository,
} from "@baas/persistence";
import type { ReadBalance } from "./read-balance.js";

export interface AccountView {
  readonly account: AccountRecord;
  readonly balance: BalanceView;
}

/**
 * Reading a customer's accounts (M1-8).
 *
 * **Absent and forbidden are the same answer.** Every lookup takes the
 * customer id and returns `undefined` when the account is not theirs, exactly
 * as it does when the account does not exist. The transport turns that into a
 * 404. Distinguishing the two would confirm that a reference is real to
 * someone who should not know, and "403 Forbidden" on an account reference is
 * an existence oracle.
 */
export class ReadAccounts {
  constructor(
    private readonly scope: TenantScope,
    private readonly accounts: AccountRepository,
    private readonly balances: ReadBalance,
  ) {}

  async forCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<readonly AccountView[]> {
    const records = await this.scope.run(tenantId, (db) =>
      this.accounts.listForCustomer(db, customerId),
    );

    // Balances are read per account rather than in one call because each is a
    // separate provider read that can independently be stale or unavailable.
    // One account's provider being down must not blank the list.
    return Promise.all(
      records.map(async (account) => ({
        account,
        balance: await this.balances.forAccount(tenantId, account),
      })),
    );
  }

  async one(
    tenantId: string,
    customerId: string,
    accountReference: string,
  ): Promise<AccountView | undefined> {
    const account = await this.scope.run(tenantId, (db) =>
      this.accounts.forCustomerByReference(db, customerId, accountReference),
    );
    if (account === undefined) {
      return undefined;
    }
    return {
      account,
      balance: await this.balances.forAccount(tenantId, account),
    };
  }
}

export class ReadTransactions {
  constructor(
    private readonly scope: TenantScope,
    private readonly accounts: AccountRepository,
    private readonly transactions: TransactionRepository,
  ) {}

  /**
   * Page an account's transactions, or `undefined` if the account is not this
   * customer's. Ownership is resolved first and in the same scope, so the
   * projection is never queried for an account the caller cannot see.
   */
  async forAccount(
    tenantId: string,
    customerId: string,
    accountReference: string,
    page: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<TransactionPageResult | undefined> {
    return this.scope.run(tenantId, async (db) => {
      const account = await this.accounts.forCustomerByReference(
        db,
        customerId,
        accountReference,
      );
      if (account === undefined) {
        return undefined;
      }
      return this.transactions.page(db, {
        accountId: account.id,
        limit: page.limit,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      });
    });
  }
}
