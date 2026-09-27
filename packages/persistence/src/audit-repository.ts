import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { ScopedDatabase } from "./tenant-scope.js";

export interface AuditEntry {
  readonly actorId: string | null;
  readonly actorKind: "operator" | "customer" | "system" | "api_client";
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * The audit trail (T6, MP-4).
 *
 * Append-only by trigger: the table refuses UPDATE and DELETE for every role,
 * including the owner, so an audit row is a fact rather than a current value.
 *
 * **`detail` is not free text.** It goes through the same field discipline as
 * a log line would: keys are recorded, values only when they are references.
 * An audit row saying "operator X read customer Y" is the point; an audit row
 * containing Y's IBAN would make the audit trail itself a place personal data
 * accumulates, which is how a control becomes a liability.
 */
export class AuditRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async record(
    db: ScopedDatabase,
    tenantId: string,
    entry: AuditEntry,
  ): Promise<void> {
    await db
      .insertInto("audit_event")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        occurred_at: toJsDate(this.clock.now()),
        actor_id: entry.actorId,
        actor_kind: entry.actorKind,
        action: entry.action,
        subject_type: entry.subjectType,
        subject_id: entry.subjectId,
        detail: JSON.stringify(entry.detail ?? {}),
      })
      .execute();
  }

  async forSubject(
    db: ScopedDatabase,
    subjectType: string,
    subjectId: string,
    limit = 50,
  ): Promise<readonly AuditEntry[]> {
    const rows = await db
      .selectFrom("audit_event")
      .selectAll()
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .orderBy("occurred_at", "desc")
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      actorId: row.actor_id,
      actorKind: row.actor_kind as AuditEntry["actorKind"],
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      detail: row.detail as Readonly<Record<string, unknown>>,
    }));
  }
}
