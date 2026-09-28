import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
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

/** An API client as an operator sees it, with the scopes it holds today. */
export interface ApiClientRecord {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly createdAt: Date;
  readonly liveScopes: readonly string[];
}

/** One grant, live or revoked. Nothing is ever removed from this history. */
export interface ScopeGrant {
  readonly id: string;
  readonly scope: string;
  readonly grantedAt: Date;
  readonly grantedBy: string | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly reason: string;
}

export class ScopeAlreadyGrantedError extends Error {
  readonly code = "persistence.api_client_scope.already_granted";

  constructor(readonly scope: string) {
    super(`"${scope}" is already granted to this client`);
    this.name = "ScopeAlreadyGrantedError";
  }
}

/**
 * Granting and revoking an API client's scopes (MP-3, findings D2 and F2).
 *
 * **There is no method that takes a list.** The incumbent's `PATCH` replaces
 * the scope array wholesale, which means a request that omits a scope revokes
 * it silently, two operators editing at once lose one another's work, and
 * nothing records who did what. One scope at a time, with a reason, is slower
 * to use and is the only shape that can be audited honestly.
 *
 * **Nothing is ever deleted or rewritten.** A revocation stamps the live row
 * and a re-grant inserts a new one, so the history is complete by construction
 * rather than by discipline. (Correction C17: the plan said "a revocation is a
 * new row"; the schema stamps the existing one. The invariant that matters —
 * no history is lost — holds either way, and the schema's partial unique index
 * is what makes it work.)
 */
export class ApiClientAdminRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Every client belonging to this tenant.
   *
   * Filtered by `tenant_id` in the query, not afterwards. `api_client` carries
   * no row-level policy — it cannot, because reading it is how the tenant is
   * established — so this is the only thing standing between an operator and
   * another tenant's credentials.
   */
  async list(
    db: Kysely<Database>,
    tenantId: string,
  ): Promise<readonly ApiClientRecord[]> {
    const clients = await db
      .selectFrom("api_client")
      .select(["id", "client_id", "name", "disabled_at", "created_at"])
      .where("tenant_id", "=", tenantId)
      .orderBy("client_id")
      .execute();

    if (clients.length === 0) {
      return [];
    }

    const live = await db
      .selectFrom("api_client_scope")
      .select(["api_client_id", "scope"])
      .where(
        "api_client_id",
        "in",
        clients.map((client) => client.id),
      )
      .where("revoked_at", "is", null)
      .orderBy("scope")
      .execute();

    return clients.map((client) => ({
      id: client.id,
      clientId: client.client_id,
      name: client.name,
      disabled: client.disabled_at !== null,
      createdAt: client.created_at,
      liveScopes: live
        .filter((grant) => grant.api_client_id === client.id)
        .map((grant) => grant.scope),
    }));
  }

  /** Confirm a client is this tenant's before anything is done to it. */
  async belongsToTenant(
    db: Kysely<Database>,
    tenantId: string,
    apiClientId: string,
  ): Promise<boolean> {
    const found = await db
      .selectFrom("api_client")
      .select("id")
      .where("id", "=", apiClientId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    return found !== undefined;
  }

  /** Every grant this client has ever had, newest first. */
  async scopeHistory(
    db: Kysely<Database>,
    apiClientId: string,
  ): Promise<readonly ScopeGrant[]> {
    const rows = await db
      .selectFrom("api_client_scope")
      .selectAll()
      .where("api_client_id", "=", apiClientId)
      .orderBy("granted_at", "desc")
      .orderBy("id", "desc")
      .execute();

    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      reason: row.reason,
    }));
  }

  /**
   * Grant one scope, with a reason.
   *
   * The partial unique index refuses a second live grant of the same scope, so
   * a double-click is an error rather than two rows that disagree.
   */
  async grant(
    db: Kysely<Database>,
    request: {
      readonly apiClientId: string;
      readonly scope: string;
      readonly grantedBy: string;
      readonly reason: string;
    },
  ): Promise<string> {
    const existing = await db
      .selectFrom("api_client_scope")
      .select("id")
      .where("api_client_id", "=", request.apiClientId)
      .where("scope", "=", request.scope)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new ScopeAlreadyGrantedError(request.scope);
    }

    const id = this.ids.next();
    await db
      .insertInto("api_client_scope")
      .values({
        id,
        api_client_id: request.apiClientId,
        scope: request.scope,
        granted_at: toJsDate(this.clock.now()),
        granted_by: request.grantedBy,
        revoked_at: null,
        revoked_by: null,
        reason: request.reason,
      })
      .execute();
    return id;
  }

  /**
   * Revoke the live grant of one scope. `false` when there was none.
   *
   * The row stays and is stamped; it is not deleted. A revoked grant is the
   * only evidence that access once existed, which is exactly what an audit
   * asks about afterwards.
   */
  async revoke(
    db: Kysely<Database>,
    request: {
      readonly apiClientId: string;
      readonly scope: string;
      readonly revokedBy: string;
    },
  ): Promise<boolean> {
    const result = await db
      .updateTable("api_client_scope")
      .set({
        revoked_at: toJsDate(this.clock.now()),
        revoked_by: request.revokedBy,
      })
      .where("api_client_id", "=", request.apiClientId)
      .where("scope", "=", request.scope)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
