import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import { Duration } from "@baas/domain";
import type { Clock, IdGenerator, Instant } from "@baas/domain";
import { fromJsDate, toJsDate } from "@baas/platform";
import type { Database } from "./schema.js";
import type { ScopedDatabase } from "./tenant-scope.js";

export const ROLE_ADMIN = "admin";
export const ROLE_APPROVER = "approver";
export const ROLE_OPERATOR = "operator";

export interface OperatorIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
}

export interface OperatorRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly disabled: boolean;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly operatorId: string;
  readonly roles: readonly string[];
  readonly email: string | null;
}

export interface IssuedSession {
  /** Returned once, to the operator. Never stored. */
  readonly token: string;
  readonly expiresAt: Instant;
}

/** SHA-256 is right here and bcrypt is not: the token is 256 bits of entropy
 * we generated, so there is nothing to brute-force and nothing to slow down.
 * Hashing exists so a leaked database is not a set of live sessions. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class OperatorRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Find or create the operator behind a verified identity.
   *
   * An identity is `(issuer, subject)`. The same subject from a different
   * issuer is a different person — assuming otherwise is how a test identity
   * provider becomes a way in.
   *
   * Registering on first sign-in does **not** grant any role. A new operator
   * can authenticate and do nothing, which is the correct default: authority
   * is granted by a person, not by the provider's say-so.
   */
  async upsert(
    db: ScopedDatabase,
    tenantId: string,
    identity: OperatorIdentity,
  ): Promise<OperatorRecord> {
    const now = toJsDate(this.clock.now());
    await db
      .insertInto("operator")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email ?? null,
        display_name: identity.displayName ?? null,
        disabled_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["issuer", "subject"]).doUpdateSet({
          email: identity.email ?? null,
          display_name: identity.displayName ?? null,
          updated_at: now,
        }),
      )
      .execute();

    const row = await db
      .selectFrom("operator")
      .selectAll()
      .where("issuer", "=", identity.issuer)
      .where("subject", "=", identity.subject)
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      displayName: row.display_name,
      disabled: row.disabled_at !== null,
    };
  }

  async rolesOf(
    db: ScopedDatabase,
    operatorId: string,
  ): Promise<readonly string[]> {
    const rows = await db
      .selectFrom("operator_role")
      .select("role")
      .where("operator_id", "=", operatorId)
      .where("revoked_at", "is", null)
      .orderBy("role")
      .execute();
    return rows.map((row) => row.role);
  }

  async grantRole(
    db: ScopedDatabase,
    tenantId: string,
    grant: {
      operatorId: string;
      role: string;
      grantedBy: string | null;
      reason: string;
    },
  ): Promise<void> {
    await db
      .insertInto("operator_role")
      .values({
        id: this.ids.next(),
        operator_id: grant.operatorId,
        tenant_id: tenantId,
        role: grant.role,
        granted_at: toJsDate(this.clock.now()),
        granted_by: grant.grantedBy,
        revoked_at: null,
        revoked_by: null,
        reason: grant.reason,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }

  async issueSession(
    db: ScopedDatabase,
    tenantId: string,
    operatorId: string,
    lifetime: Duration = Duration.ofHours(8),
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    const expiresAt = now.plus(lifetime);

    await db
      .insertInto("operator_session")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        operator_id: operatorId,
        token_hash: hashToken(token),
        issued_at: toJsDate(now),
        expires_at: toJsDate(expiresAt),
        revoked_at: null,
        last_seen_at: null,
      })
      .execute();

    return { token, expiresAt };
  }

  /**
   * Resolve a bearer token to a live session.
   *
   * Read **outside** a tenant scope, like `api_client`: looking it up is how
   * the tenant is discovered, so a policy requiring the tenant to be known
   * already would be unsatisfiable (see 0003).
   *
   * Every check is here rather than spread across guards — expired, revoked,
   * and the operator disabled since the session was issued. That last one is
   * why sessions are server-side: a stateless token would keep working.
   */
  async resolveSession(
    db: Kysely<Database>,
    token: string,
  ): Promise<ResolvedSession | undefined> {
    const now = this.clock.now();
    const row = await db
      .selectFrom("operator_session")
      .innerJoin("operator", "operator.id", "operator_session.operator_id")
      .select([
        "operator_session.id as session_id",
        "operator_session.tenant_id as tenant_id",
        "operator_session.operator_id as operator_id",
        "operator_session.expires_at as expires_at",
        "operator_session.revoked_at as revoked_at",
        "operator.disabled_at as disabled_at",
        "operator.email as email",
      ])
      .where("operator_session.token_hash", "=", hashToken(token))
      .executeTakeFirst();

    if (
      row === undefined ||
      row.revoked_at !== null ||
      row.disabled_at !== null ||
      !fromJsDate(row.expires_at).isAfter(now)
    ) {
      return undefined;
    }

    const roles = await db
      .selectFrom("operator_role")
      .select("role")
      .where("operator_id", "=", row.operator_id)
      .where("revoked_at", "is", null)
      .orderBy("role")
      .execute();

    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      operatorId: row.operator_id,
      roles: roles.map((role) => role.role),
      email: row.email,
    };
  }

  async touch(db: Kysely<Database>, sessionId: string): Promise<void> {
    await db
      .updateTable("operator_session")
      .set({ last_seen_at: toJsDate(this.clock.now()) })
      .where("id", "=", sessionId)
      .execute();
  }

  /** Revocation takes effect on the next request, which is the point. */
  async revokeSession(db: Kysely<Database>, sessionId: string): Promise<void> {
    await db
      .updateTable("operator_session")
      .set({ revoked_at: toJsDate(this.clock.now()) })
      .where("id", "=", sessionId)
      .execute();
  }

  async revokeAllFor(db: ScopedDatabase, operatorId: string): Promise<number> {
    const result = await db
      .updateTable("operator_session")
      .set({ revoked_at: toJsDate(this.clock.now()) })
      .where("operator_id", "=", operatorId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

/** Exported for the one test that proves hashing is constant-time-compared. */
export function tokensMatch(presented: string, stored: string): boolean {
  const left = Buffer.from(hashToken(presented));
  const right = Buffer.from(stored);
  return left.length === right.length && timingSafeEqual(left, right);
}
