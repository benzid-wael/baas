import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { ScopedDatabase } from "./tenant-scope.js";
import type { AccountProduct, AccountStatus } from "./schema.js";

/**
 * Accounts (M1-3).
 *
 * What an account *is*: a reference at a provider, a product, a currency, a
 * lifecycle state and the identifiers someone can be paid at. What it is not:
 * a balance. Balances are observations with a time (M1-5), and putting one on
 * this record would make a cache look like a fact.
 */
export interface AccountRecord {
  readonly id: string;
  readonly customerId: string;
  readonly providerId: string;
  readonly accountReference: string;
  readonly product: AccountProduct;
  readonly currency: string;
  readonly status: AccountStatus;
  readonly statusReason: string | null;
  readonly iban: string | null;
  readonly accountNumber: string | null;
  readonly sortCode: string | null;
  readonly bic: string | null;
  readonly openedAt: Date | null;
  readonly observedAt: Date;
}

export interface ObservedAccount {
  readonly customerId: string;
  readonly providerId: string;
  readonly accountReference: string;
  readonly product: AccountProduct;
  readonly currency: string;
  readonly status: AccountStatus;
  readonly statusReason?: string | null;
  readonly iban?: string | null;
  readonly accountNumber?: string | null;
  readonly sortCode?: string | null;
  readonly bic?: string | null;
  readonly openedAt?: Date | null;
}

export class AccountRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async listForCustomer(
    db: ScopedDatabase,
    customerId: string,
  ): Promise<readonly AccountRecord[]> {
    const rows = await db
      .selectFrom("account")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("provider_id")
      .orderBy("account_reference")
      .execute();
    return rows.map(toRecord);
  }

  /**
   * Every account in the tenant, for work that is not on behalf of a customer
   * — today, the transaction projector (New-18).
   *
   * `limit` is required and has no default. A background job that silently
   * reads the whole table works until the table is large, and then stops
   * working in a way nobody wrote down. The caller states how much it can
   * handle in one pass, and `afterId` walks the rest: ids are uuidv7, so id
   * order is insertion order and the walk is stable under concurrent writes.
   */
  async listForTenant(
    db: ScopedDatabase,
    page: { readonly limit: number; readonly afterId?: string },
  ): Promise<readonly AccountRecord[]> {
    let query = db
      .selectFrom("account")
      .selectAll()
      .orderBy("id")
      .limit(page.limit);
    if (page.afterId !== undefined) {
      query = query.where("id", ">", page.afterId);
    }
    return (await query.execute()).map(toRecord);
  }

  /**
   * Fetch one account **that belongs to this customer**.
   *
   * The customer id is part of the query rather than checked afterwards. A
   * check after the fact is a check somebody eventually forgets, and the
   * failure mode is reading another customer's account.
   */
  async forCustomerByReference(
    db: ScopedDatabase,
    customerId: string,
    accountReference: string,
  ): Promise<AccountRecord | undefined> {
    const row = await db
      .selectFrom("account")
      .selectAll()
      .where("customer_id", "=", customerId)
      .where("account_reference", "=", accountReference)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Record what a provider said about an account.
   *
   * Only callable inside `TenantScope.runAsProviderSync`; a trigger refuses
   * the write otherwise.
   */
  async observe(
    db: ScopedDatabase,
    tenantId: string,
    observed: ObservedAccount,
  ): Promise<void> {
    const now = toJsDate(this.clock.now());
    const written = await db
      .insertInto("account")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        customer_id: observed.customerId,
        provider_id: observed.providerId,
        account_reference: observed.accountReference,
        product: observed.product,
        currency: observed.currency,
        status: observed.status,
        status_reason: observed.statusReason ?? null,
        iban: observed.iban ?? null,
        account_number: observed.accountNumber ?? null,
        sort_code: observed.sortCode ?? null,
        bic: observed.bic ?? null,
        opened_at: observed.openedAt ?? null,
        observed_at: now,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["provider_id", "account_reference"])
          .doUpdateSet({
            status: observed.status,
            status_reason: observed.statusReason ?? null,
            iban: observed.iban ?? null,
            account_number: observed.accountNumber ?? null,
            sort_code: observed.sortCode ?? null,
            bic: observed.bic ?? null,
            opened_at: observed.openedAt ?? null,
            observed_at: now,
          })
          // Only update when the owner is unchanged. A reference that already
          // belongs to a different customer is not an update, and silently
          // keeping the old owner while refreshing everything else would leave
          // ownership stale and every other field current — the worst possible
          // combination for a read surface.
          .whereRef("account.customer_id", "=", "excluded.customer_id"),
      )
      .executeTakeFirst();

    if ((written.numInsertedOrUpdatedRows ?? 0n) === 0n) {
      throw new AccountOwnershipConflictError(
        observed.providerId,
        observed.accountReference,
      );
    }
  }
}

export class AccountOwnershipConflictError extends Error {
  readonly code = "persistence.account.ownership_conflict";

  constructor(
    readonly providerId: string,
    readonly accountReference: string,
  ) {
    super(
      `Account ${providerId}/${accountReference} is already held by a different customer. ` +
        "A provider reference does not change hands; investigate the sync mapping rather than overwriting.",
    );
    this.name = "AccountOwnershipConflictError";
  }
}

function toRecord(row: {
  id: string;
  customer_id: string;
  provider_id: string;
  account_reference: string;
  product: AccountProduct;
  currency: string;
  status: AccountStatus;
  status_reason: string | null;
  iban: string | null;
  account_number: string | null;
  sort_code: string | null;
  bic: string | null;
  opened_at: Date | null;
  observed_at: Date;
}): AccountRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    accountReference: row.account_reference,
    product: row.product,
    currency: row.currency,
    status: row.status,
    statusReason: row.status_reason,
    iban: row.iban,
    accountNumber: row.account_number,
    sortCode: row.sort_code,
    bic: row.bic,
    openedAt: row.opened_at,
    observedAt: row.observed_at,
  };
}
