import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { Database } from "./schema.js";

/**
 * Every tenant-scoped read and write happens inside one of these (M1-1).
 *
 * Three things happen in one transaction, and all three matter:
 *
 * 1. **`SET LOCAL ROLE baas_app`** — drops to a role that owns nothing, so
 *    row-level security applies. A superuser bypasses RLS entirely, even
 *    under `FORCE ROW LEVEL SECURITY`, and the first version of the T6
 *    isolation test passed vacuously for exactly that reason. Doing it here
 *    means isolation does not depend on a deployment choosing the right
 *    connection user — it is defence that holds even when ops gets it wrong.
 *
 * 2. **`set_config('app.tenant_id', ..., true)`** — transaction-local, not
 *    session-local. `pg` pools connections, so the session form outlives the
 *    request that set it and the next request on that connection inherits the
 *    previous tenant's context. Under RLS that is a cross-tenant read. This is
 *    the whole of New-14.
 *
 * 3. **A scoped executor** is handed to the caller. Repositories take one of
 *    these rather than the raw `Kysely`, so a query outside a tenant scope is
 *    a type error rather than a silent full-table read.
 *
 * Both settings are released when the transaction ends, including when it
 * aborts. Nothing relies on a `finally`, because a connection returned to the
 * pool after a crash would keep anything a `finally` was supposed to reset.
 */
export type ScopedDatabase = Transaction<Database> & {
  readonly __tenantScoped: unique symbol;
};

/** The application role. Owns nothing, creates nothing, subject to RLS. */
export const APPLICATION_ROLE = "baas_app";

export class TenantScope {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Run `work` with the tenant context established.
   *
   * There is no variant without a tenant: a caller that genuinely needs a
   * registry table reads it through `registry()` below, which says so.
   */
  async run<T>(
    tenantId: string,
    work: (db: ScopedDatabase) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.raw(APPLICATION_ROLE)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(
        trx,
      );
      return work(trx as ScopedDatabase);
    });
  }

  /**
   * Run `work` with the tenant context established **and** provider-sync
   * writes permitted.
   *
   * `provider_customer_link` is derived from what a provider told us, and a
   * trigger refuses to write it unless `app.provider_sync` is set. The
   * incumbent lets an operator edit link status directly, and the edit is
   * silently reverted on the next sync (finding D4) — which is worse than
   * being refused, because it looks like it worked.
   *
   * Separate and named so that the one code path allowed to write derived
   * state says so, and so that everything else structurally cannot.
   */
  async runAsProviderSync<T>(
    tenantId: string,
    work: (db: ScopedDatabase) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.raw(APPLICATION_ROLE)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(
        trx,
      );
      await sql`SELECT set_config('app.provider_sync', 'on', true)`.execute(
        trx,
      );
      return work(trx as ScopedDatabase);
    });
  }

  /**
   * Run `work` as the projector, permitting writes to the read model.
   *
   * Finding A7: the incumbent's settlement state is written by several
   * services, so no single place can be read to know what happened. The read
   * model here has exactly one writer, and this is it — deliberately separate
   * from `runAsProviderSync`, because "we observed the provider" and "we
   * derived the read model" are different acts and sharing a grant would let
   * either do the other's job.
   */
  async runAsProjector<T>(
    tenantId: string,
    work: (db: ScopedDatabase) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.raw(APPLICATION_ROLE)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(
        trx,
      );
      await sql`SELECT set_config('app.projector', 'on', true)`.execute(trx);
      return work(trx as ScopedDatabase);
    });
  }

  /**
   * Read a registry table — `tenant`, `api_client`, `api_client_scope` —
   * which by definition cannot be tenant-scoped, because reading it is how the
   * tenant is established.
   *
   * Separate and named so that it reads as a deliberate exception at every
   * call site, rather than as an ordinary query that happens to skip the
   * scope.
   */
  async registry<T>(work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return work(this.db);
  }
}
