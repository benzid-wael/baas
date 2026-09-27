import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/**
 * An API client credential, as the guard chain needs it (New-18).
 *
 * Read through `TenantScope.registry()`, never through a tenant scope: reading
 * this row is *how* the tenant is established, so it cannot itself be
 * tenant-scoped. That is the one legitimate unscoped read on this table and it
 * says so at the call site.
 */
export interface ApiClientCredential {
  readonly id: string;
  readonly tenantId: string;
  readonly secretHash: string;
  readonly disabled: boolean;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
}

export class ApiClientRepository {
  /**
   * Look a client up by the id it presents.
   *
   * Returns the record even when it is disabled, and says so in `disabled`.
   * The guard needs it either way: it compares the secret regardless of the
   * outcome so that an unknown client and a wrong secret take the same time,
   * and short-circuiting here would put that timing difference back.
   */
  async byClientId(
    db: Kysely<Database>,
    clientId: string,
  ): Promise<ApiClientCredential | undefined> {
    const client = await db
      .selectFrom("api_client")
      .select(["id", "tenant_id", "secret_hash", "disabled_at"])
      .where("client_id", "=", clientId)
      .executeTakeFirst();

    if (client === undefined) {
      return undefined;
    }

    // Live grants only. A revoked grant stays in the table as history (D2) and
    // must not confer anything.
    const scopes = await db
      .selectFrom("api_client_scope")
      .select("scope")
      .where("api_client_id", "=", client.id)
      .where("revoked_at", "is", null)
      .orderBy("scope")
      .execute();

    return {
      id: client.id,
      tenantId: client.tenant_id,
      secretHash: client.secret_hash,
      disabled: client.disabled_at !== null,
      scopes: scopes.map((row) => row.scope),
      // An API client holds no role today, and the empty list is the answer
      // rather than a placeholder: authority on the mobile surface comes from
      // the forwarded end-user identity, and authority on the operator surface
      // comes from a session. There is no third source, so there is no
      // `api_client_role` table to read.
      roles: [],
    };
  }
}
