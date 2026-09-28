import type {
  ApiClientAdminRepository,
  ApiClientRecord,
  AuditRepository,
  ScopeGrant,
  ScopedDatabase,
  TenantScope,
} from "@baas/persistence";
import type { Actor } from "./operator-reads.js";

/**
 * Administering an API client's scopes (MP-3, findings D2 and F2).
 *
 * Both halves of the incumbent's defect matter and only fixing one reproduces
 * it. **D2**: its `PATCH` replaces the scope array wholesale and writes no
 * audit row, so nobody can say who granted what. **F2**: its portal cannot
 * edit scopes at all, so the changes are made directly in the database — where
 * there is certainly no audit row. Building the editor without the audit would
 * simply move the unaudited change into the console.
 *
 * So: one scope at a time, a reason required, and **the audit row is written
 * in the same transaction as the change**. A grant that cannot be recorded
 * does not happen.
 */
export class ApiClientNotFoundError extends Error {
  readonly code = "application.api_client.not_found";

  constructor() {
    super("no such API client");
    this.name = "ApiClientNotFoundError";
  }
}

export interface GrantRequest {
  readonly apiClientId: string;
  readonly scope: string;
  /** Required, and stored. "why" is the question an audit actually asks. */
  readonly reason: string;
}

export class ApiClientAdmin {
  constructor(
    private readonly scope: TenantScope,
    private readonly clients: ApiClientAdminRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * The clients this tenant has.
   *
   * **Not audited.** It lists client ids, names and scope names — no secret,
   * no personal data, nothing about a customer. The rule stays "reading a
   * customer is audited"; auditing a list an operator refreshes would bury the
   * grants and revocations below, which are the rows that matter here.
   */
  async list(tenantId: string): Promise<readonly ApiClientRecord[]> {
    return this.scope.registry((db) => this.clients.list(db, tenantId));
  }

  async history(
    tenantId: string,
    apiClientId: string,
  ): Promise<readonly ScopeGrant[]> {
    return this.scope.registry(async (db) => {
      if (!(await this.clients.belongsToTenant(db, tenantId, apiClientId))) {
        throw new ApiClientNotFoundError();
      }
      return this.clients.scopeHistory(db, apiClientId);
    });
  }

  async grant(
    tenantId: string,
    actor: Actor,
    request: GrantRequest,
  ): Promise<void> {
    await this.change(tenantId, actor, request.apiClientId, async (db) => {
      await this.clients.grant(db, {
        apiClientId: request.apiClientId,
        scope: request.scope,
        grantedBy: actor.operatorId,
        reason: request.reason,
      });
      return { action: "api_client.scope_granted", scope: request.scope };
    });
  }

  /** `false` when the client did not hold that scope. Not an error: a */
  /** revocation of something already revoked is a no-op, not a failure. */
  async revoke(
    tenantId: string,
    actor: Actor,
    apiClientId: string,
    scope: string,
  ): Promise<boolean> {
    let revoked = false;
    await this.change(tenantId, actor, apiClientId, async (db) => {
      revoked = await this.clients.revoke(db, {
        apiClientId,
        scope,
        revokedBy: actor.operatorId,
      });
      // Recorded either way. An attempt to revoke something that was not there
      // is worth seeing: it usually means two people are working on the same
      // client, or somebody is looking at a stale screen.
      return { action: "api_client.scope_revoked", scope, revoked };
    });
    return revoked;
  }

  /**
   * The shape both mutations share: confirm the client is this tenant's, make
   * the change, and write the audit row — all in **one transaction**, so a
   * change that cannot be recorded does not happen.
   *
   * `runAsScopeAdmin` rather than `registry`, because `api_client_scope` is
   * readable by the application role and writable only inside that scope. The
   * tenant check is a `WHERE` clause rather than a row policy — the table has
   * no tenant column, and `api_client` cannot have a policy because reading it
   * is how the tenant is established — so it happens first, before anything is
   * written.
   */
  private async change(
    tenantId: string,
    actor: Actor,
    apiClientId: string,
    work: (
      db: ScopedDatabase,
    ) => Promise<{ action: string } & Record<string, unknown>>,
  ): Promise<void> {
    await this.scope.runAsScopeAdmin(tenantId, async (db) => {
      if (!(await this.clients.belongsToTenant(db, tenantId, apiClientId))) {
        throw new ApiClientNotFoundError();
      }
      const { action, ...detail } = await work(db);
      await this.audit.record(db, tenantId, {
        actorId: actor.operatorId,
        actorKind: "operator",
        action,
        subjectType: "api_client",
        subjectId: apiClientId,
        detail,
      });
    });
  }
}
