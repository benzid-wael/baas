import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "./schema.js";

/**
 * Schema-drift gate (task T5, finding A4).
 *
 * The declared types in `schema.ts` and the migrated database are compared
 * column by column. A column that migrations created and nothing declares, or
 * a declaration with no column behind it, fails the build.
 *
 * This is the structural answer to the incumbent's
 * `fintech_account_request."reconciliationId"`: created by a migration,
 * written by raw SQL, declared by no entity, and therefore absent from every
 * environment whose schema came from `synchronize` — where account-opening
 * approval failed with a 500 naming a missing column while the readiness probe
 * reported healthy throughout.
 */
export interface ColumnInfo {
  readonly table: string;
  readonly column: string;
  readonly nullable: boolean;
}

export async function introspect(
  db: Kysely<Database>,
): Promise<readonly ColumnInfo[]> {
  const result = await sql<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `.execute(db);

  return result.rows.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    nullable: row.is_nullable === "YES",
  }));
}

export interface DriftReport {
  readonly undeclared: readonly string[];
  readonly missing: readonly string[];
}

export function compareSchema(
  actual: readonly ColumnInfo[],
  declared: Readonly<Record<string, readonly string[]>>,
): DriftReport {
  const actualByTable = new Map<string, Set<string>>();
  for (const column of actual) {
    const columns = actualByTable.get(column.table) ?? new Set<string>();
    columns.add(column.column);
    actualByTable.set(column.table, columns);
  }

  const undeclared: string[] = [];
  const missing: string[] = [];

  for (const [table, columns] of actualByTable) {
    const expected = declared[table];
    if (expected === undefined) {
      undeclared.push(`${table} (whole table)`);
      continue;
    }
    for (const column of columns) {
      if (!expected.includes(column)) {
        undeclared.push(`${table}.${column}`);
      }
    }
  }

  for (const [table, columns] of Object.entries(declared)) {
    const found = actualByTable.get(table);
    if (found === undefined) {
      missing.push(`${table} (whole table)`);
      continue;
    }
    for (const column of columns) {
      if (!found.has(column)) {
        missing.push(`${table}.${column}`);
      }
    }
  }

  return { undeclared: undeclared.sort(), missing: missing.sort() };
}

/**
 * The declared shape, as data.
 *
 * Kept beside the types rather than derived from them: TypeScript interfaces
 * do not exist at runtime, and generating this from the type system would put
 * a compiler plugin between a migration and the check that catches it.
 */
export const DECLARED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  schema_migration: ["id", "applied_at", "irreversible_reason"],
  tenant: ["id", "slug", "name", "created_at"],
  api_client: [
    "id",
    "tenant_id",
    "client_id",
    "secret_hash",
    "name",
    "disabled_at",
    "created_at",
  ],
  api_client_scope: [
    "id",
    "api_client_id",
    "scope",
    "granted_at",
    "granted_by",
    "revoked_at",
    "revoked_by",
    "reason",
  ],
  customer: [
    "id",
    "tenant_id",
    "external_user_uuid",
    "created_at",
    "updated_at",
  ],
  provider_customer_link: [
    "id",
    "tenant_id",
    "customer_id",
    "provider_id",
    "external_customer_id",
    "status",
    "status_reason",
    "observed_at",
    "created_at",
  ],
  idempotency_record: [
    "id",
    "tenant_id",
    "scope",
    "idempotency_key",
    "request_fingerprint",
    "state",
    "result",
    "created_at",
    "completed_at",
  ],
  effect_outbox: [
    "id",
    "tenant_id",
    "aggregate_type",
    "aggregate_id",
    "provider_id",
    "operation",
    "payload",
    "state",
    "attempts",
    "next_attempt_at",
    "lease_until",
    "leased_by",
    "provider_ref",
    "last_error",
    "created_at",
    "updated_at",
  ],
  provider_inbox: [
    "id",
    "tenant_id",
    "provider_id",
    "external_event_id",
    "event_type",
    "provider_ref",
    "signature_verified",
    "payload",
    "received_at",
    "processed_at",
    "process_error",
  ],
  audit_event: [
    "id",
    "tenant_id",
    "occurred_at",
    "actor_id",
    "actor_kind",
    "action",
    "subject_type",
    "subject_id",
    "detail",
  ],
};

/**
 * Readiness asserts the schema, not the migration ledger.
 *
 * Finding C1: `/system/ready` reports healthy when a migration is *recorded*,
 * even if its statements did not apply. Comparing columns is what makes the
 * probe mean what operators assume it means.
 */
export async function assertSchemaMatches(db: Kysely<Database>): Promise<void> {
  const report = compareSchema(await introspect(db), DECLARED_SCHEMA);
  if (report.undeclared.length === 0 && report.missing.length === 0) {
    return;
  }
  throw new SchemaDriftError(report);
}

export class SchemaDriftError extends Error {
  readonly code = "persistence.schema.drift";

  constructor(readonly report: DriftReport) {
    super(
      [
        "Schema drift between migrations and declarations:",
        ...report.undeclared.map(
          (entry) => `  - ${entry} exists but is not declared`,
        ),
        ...report.missing.map(
          (entry) => `  - ${entry} is declared but does not exist`,
        ),
      ].join("\n"),
    );
    this.name = "SchemaDriftError";
  }
}
