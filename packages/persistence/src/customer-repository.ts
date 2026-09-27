import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { ScopedDatabase } from "./tenant-scope.js";
import type { ProviderLinkStatus } from "./schema.js";

/**
 * The customer registry (M1-2).
 *
 * Every method takes a `ScopedDatabase`, so it cannot be called outside a
 * tenant scope. That is the whole reason the type is branded.
 */
export interface CustomerRecord {
  readonly id: string;
  readonly externalUserUuid: string;
}

export interface ProviderLink {
  readonly providerId: string;
  readonly externalCustomerId: string;
  readonly status: ProviderLinkStatus;
  readonly statusReason: string | null;
  readonly observedAt: Date;
}

export interface ObservedLink {
  readonly customerId: string;
  readonly providerId: string;
  readonly externalCustomerId: string;
  readonly status: ProviderLinkStatus;
  readonly statusReason?: string | null;
}

export class CustomerRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async byExternalUuid(
    db: ScopedDatabase,
    externalUserUuid: string,
  ): Promise<CustomerRecord | undefined> {
    const row = await db
      .selectFrom("customer")
      .select(["id", "external_user_uuid"])
      .where("external_user_uuid", "=", externalUserUuid)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { id: row.id, externalUserUuid: row.external_user_uuid };
  }

  /**
   * Register a customer, or return the one already there.
   *
   * Idempotent on `(tenant, external uuid)` rather than "check then insert":
   * two requests arriving together for a first-time user is the normal case,
   * not a race worth losing.
   */
  async register(
    db: ScopedDatabase,
    tenantId: string,
    externalUserUuid: string,
  ): Promise<CustomerRecord> {
    const now = toJsDate(this.clock.now());
    await db
      .insertInto("customer")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        external_user_uuid: externalUserUuid,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["tenant_id", "external_user_uuid"]).doNothing(),
      )
      .execute();

    const row = await this.byExternalUuid(db, externalUserUuid);
    /* c8 ignore next 3 -- the insert above guarantees a row within the scope */
    if (row === undefined) {
      throw new Error("customer disappeared immediately after registration");
    }
    return row;
  }

  async linksOf(
    db: ScopedDatabase,
    customerId: string,
  ): Promise<readonly ProviderLink[]> {
    const rows = await db
      .selectFrom("provider_customer_link")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("provider_id")
      .execute();

    return rows.map((row) => ({
      providerId: row.provider_id,
      externalCustomerId: row.external_customer_id,
      status: row.status,
      statusReason: row.status_reason,
      observedAt: row.observed_at,
    }));
  }

  /**
   * Record what a provider said about a customer.
   *
   * Only callable inside `TenantScope.runAsProviderSync` — a trigger refuses
   * the write otherwise, so an ordinary request path cannot perform one
   * however it is written.
   */
  async observeLink(
    db: ScopedDatabase,
    tenantId: string,
    observed: ObservedLink,
  ): Promise<void> {
    const now = toJsDate(this.clock.now());
    await db
      .insertInto("provider_customer_link")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        customer_id: observed.customerId,
        provider_id: observed.providerId,
        external_customer_id: observed.externalCustomerId,
        status: observed.status,
        status_reason: observed.statusReason ?? null,
        observed_at: now,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "provider_id", "customer_id"])
          .doUpdateSet({
            external_customer_id: observed.externalCustomerId,
            status: observed.status,
            status_reason: observed.statusReason ?? null,
            observed_at: now,
          }),
      )
      .execute();
  }
}
