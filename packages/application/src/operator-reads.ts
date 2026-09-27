import type { BalanceView } from "@baas/domain";
import type {
  AccountRecord,
  AccountRepository,
  AuditRepository,
  CustomerRepository,
  ProviderLink,
  ScopedDatabase,
  TenantScope,
  TransactionPageResult,
  TransactionRepository,
} from "@baas/persistence";
import type { ReadBalance } from "./read-balance.js";

/**
 * What an operator is reading on behalf of whom.
 *
 * Passed explicitly rather than read from ambient context, so that no read
 * can be written without saying who is doing it — which is what makes the
 * audit unavoidable rather than remembered.
 */
export interface Actor {
  readonly operatorId: string;
}

export interface CustomerSummary {
  readonly customerId: string;
  readonly externalUserUuid: string;
  readonly links: readonly ProviderLink[];
}

export interface OperatorAccountView {
  readonly account: AccountRecord;
  readonly balance: BalanceView;
}

/**
 * Reads for the operator console (MP-4).
 *
 * A **separate surface** from `/mobile`, not the same handlers behind a
 * different guard. An operator reads *any* customer in the tenant, which is
 * precisely the authority a mobile route must never have; sharing a handler
 * between the two is how that authority leaks the first time someone adds a
 * parameter.
 *
 * Two rules hold throughout:
 *
 * 1. **Every read is audited, and an unauditable read does not happen.** The
 *    audit row is written in the same transaction as the lookup, so a failure
 *    to record fails the read. Serving a customer's data when we cannot say
 *    who saw it is the thing this console exists to avoid, and "log it and
 *    carry on" would make the audit trail advisory.
 * 2. **Lookup is exact-match only.** There is no listing and no prefix
 *    search. A console that lets someone page through every customer, or
 *    probe identifiers a character at a time, is an extraction tool. Browsing
 *    may be worth adding later; it should be a decision, not a side effect of
 *    a convenient query.
 */
export class OperatorReads {
  constructor(
    private readonly scope: TenantScope,
    private readonly customers: CustomerRepository,
    private readonly accounts: AccountRepository,
    private readonly transactions: TransactionRepository,
    private readonly balances: ReadBalance,
    private readonly audit: AuditRepository,
  ) {}

  /** By external user uuid. Exact match; see the class note. */
  async findCustomerByExternalUuid(
    tenantId: string,
    actor: Actor,
    externalUserUuid: string,
  ): Promise<CustomerSummary | undefined> {
    return this.scope.run(tenantId, async (db) => {
      const customer = await this.customers.byExternalUuid(
        db,
        externalUserUuid,
      );
      await this.recordLookup(
        db,
        tenantId,
        actor,
        "customer.lookup",
        {
          found: customer !== undefined,
        },
        customer?.id ?? externalUserUuid,
      );
      if (customer === undefined) {
        return undefined;
      }
      return {
        customerId: customer.id,
        externalUserUuid: customer.externalUserUuid,
        links: await this.customers.linksOf(db, customer.id),
      };
    });
  }

  /** By an account reference the operator already has. Exact match. */
  async findCustomerByAccountReference(
    tenantId: string,
    actor: Actor,
    accountReference: string,
  ): Promise<CustomerSummary | undefined> {
    return this.scope.run(tenantId, async (db) => {
      const account = await db
        .selectFrom("account")
        .select("customer_id")
        .where("account_reference", "=", accountReference)
        .executeTakeFirst();

      await this.recordLookup(
        db,
        tenantId,
        actor,
        "customer.lookup_by_account",
        {
          found: account !== undefined,
        },
        account?.customer_id ?? accountReference,
      );

      if (account === undefined) {
        return undefined;
      }
      const customer = await db
        .selectFrom("customer")
        .select(["id", "external_user_uuid"])
        .where("id", "=", account.customer_id)
        .executeTakeFirstOrThrow();

      return {
        customerId: customer.id,
        externalUserUuid: customer.external_user_uuid,
        links: await this.customers.linksOf(db, customer.id),
      };
    });
  }

  async accountsOf(
    tenantId: string,
    actor: Actor,
    customerId: string,
  ): Promise<readonly OperatorAccountView[]> {
    const records = await this.scope.run(tenantId, async (db) => {
      const found = await this.accounts.listForCustomer(db, customerId);
      await this.recordLookup(
        db,
        tenantId,
        actor,
        "customer.accounts_read",
        {
          count: found.length,
        },
        customerId,
      );
      return found;
    });

    // Balances are read outside the audited transaction: they call a provider,
    // and holding a database transaction open across a network call is how a
    // slow bank becomes a connection-pool outage.
    return Promise.all(
      records.map(async (account) => ({
        account,
        balance: await this.balances.forAccount(tenantId, account),
      })),
    );
  }

  /**
   * A page of an account's transactions.
   *
   * Unlike the mobile surface, this does **not** collapse "not found" into
   * "not yours". An operator asking about an account that does not exist
   * should be told so plainly — reading another customer's data is the job,
   * so there is no existence to protect, and copying the mobile rule here
   * would only make diagnosis harder.
   */
  async transactionsOf(
    tenantId: string,
    actor: Actor,
    accountReference: string,
    page: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<TransactionPageResult | undefined> {
    return this.scope.run(tenantId, async (db) => {
      const account = await db
        .selectFrom("account")
        .select(["id", "customer_id"])
        .where("account_reference", "=", accountReference)
        .executeTakeFirst();

      await this.recordLookup(
        db,
        tenantId,
        actor,
        "account.transactions_read",
        {
          found: account !== undefined,
        },
        account?.customer_id ?? accountReference,
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

  private async recordLookup(
    db: ScopedDatabase,
    tenantId: string,
    actor: Actor,
    action: string,
    detail: Readonly<Record<string, unknown>>,
    subjectId: string,
  ): Promise<void> {
    await this.audit.record(db, tenantId, {
      actorId: actor.operatorId,
      actorKind: "operator",
      action,
      subjectType: "customer",
      subjectId,
      detail,
    });
  }
}
