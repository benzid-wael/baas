import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Clock } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { SchemaMigrationTable } from "./schema.js";

/** The only table the migrator itself needs to know about. */
export interface MigratableDatabase {
  schema_migration: SchemaMigrationTable;
}

/**
 * Migrations are the only description of the schema.
 *
 * Review finding A4: the incumbent has two competing sources of truth —
 * entities and migrations — and nothing reconciles them, which is how
 * `fintech_account_request."reconciliationId"` came to be created by a
 * migration, written by raw SQL, and declared by no entity. Here there are no
 * entities. There is no `synchronize` to disable, because the concept does not
 * exist.
 *
 * Each migration is one file:
 *
 *   -- migrate:up      required
 *   -- migrate:down    required, unless the file declares
 *   -- irreversible: <reason>
 *
 * Requiring a reason rather than allowing silence means an irreversible
 * migration is a decision somebody wrote down, not one they forgot to think
 * about.
 */
export interface Migration {
  readonly id: string;
  readonly up: string;
  readonly down: string | undefined;
  readonly irreversibleReason: string | undefined;
}

const FILENAME = /^(\d{4})_[a-z0-9-]+\.sql$/;

export function parseMigration(id: string, source: string): Migration {
  const up = section(source, "migrate:up");
  if (up === undefined || up.trim() === "") {
    throw new MalformedMigrationError(id, "has no `-- migrate:up` section");
  }
  const irreversible = /^--\s*irreversible:\s*(.+)$/m.exec(source);
  const down = section(source, "migrate:down");

  if (irreversible === null && (down === undefined || down.trim() === "")) {
    throw new MalformedMigrationError(
      id,
      "has no `-- migrate:down` section and does not declare `-- irreversible: <reason>`",
    );
  }
  if (irreversible !== null && down !== undefined && down.trim() !== "") {
    throw new MalformedMigrationError(
      id,
      "declares itself irreversible and also provides a down section",
    );
  }

  return {
    id,
    up: up.trim(),
    down: down?.trim() === "" ? undefined : down?.trim(),
    irreversibleReason: irreversible?.[1]?.trim(),
  };
}

function section(source: string, marker: string): string | undefined {
  const start = source.indexOf(`-- ${marker}`);
  if (start === -1) {
    return undefined;
  }
  const from = start + `-- ${marker}`.length;
  const nextMarker = /^--\s*migrate:(up|down)\s*$/m;
  const rest = source.slice(from);
  const match = nextMarker.exec(rest);
  return match === null ? rest : rest.slice(0, match.index);
}

export function loadMigrations(directory: string): readonly Migration[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const seen = new Set<string>();
  return files.map((name) => {
    const match = FILENAME.exec(name);
    if (match === null) {
      throw new MalformedMigrationError(
        name,
        "must be named NNNN_lower-kebab.sql",
      );
    }
    const ordinal = match[1] ?? "";
    if (seen.has(ordinal)) {
      throw new MalformedMigrationError(name, `reuses ordinal ${ordinal}`);
    }
    seen.add(ordinal);
    return parseMigration(name, readFileSync(join(directory, name), "utf8"));
  });
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Apply every migration not yet recorded, each in its own transaction, in
 * order. A failure leaves the ledger and the schema agreeing, which is the
 * property the incumbent's readiness check assumes and does not have (C1).
 */
export async function migrateUp(
  db: Kysely<MigratableDatabase>,
  migrations: readonly Migration[],
  clock: Clock,
): Promise<MigrationResult> {
  await ensureLedger(db);
  const done = await appliedIds(db);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }
    await db.transaction().execute(async (trx) => {
      await sql.raw(migration.up).execute(trx);
      await trx
        .insertInto("schema_migration")
        .values({
          id: migration.id,
          applied_at: toJsDate(clock.now()),
          irreversible_reason: migration.irreversibleReason ?? null,
        })
        .execute();
    });
    applied.push(migration.id);
  }

  return { applied, alreadyApplied };
}

/** Roll back the most recent migration, refusing an irreversible one. */
export async function migrateDown(
  db: Kysely<MigratableDatabase>,
  migrations: readonly Migration[],
): Promise<string | undefined> {
  await ensureLedger(db);
  const done = await appliedIds(db);
  const last = [...migrations].reverse().find((m) => done.has(m.id));
  if (last === undefined) {
    return undefined;
  }
  if (last.down === undefined) {
    throw new IrreversibleMigrationError(
      last.id,
      last.irreversibleReason ?? "",
    );
  }
  await db.transaction().execute(async (trx) => {
    await sql.raw(last.down ?? "").execute(trx);
    await trx
      .deleteFrom("schema_migration")
      .where("id", "=", last.id)
      .execute();
  });
  return last.id;
}

async function ensureLedger(db: Kysely<MigratableDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id                   text PRIMARY KEY,
      applied_at           timestamptz NOT NULL,
      irreversible_reason  text
    )
  `.execute(db);
}

async function appliedIds(
  db: Kysely<MigratableDatabase>,
): Promise<Set<string>> {
  const result = await sql<{
    id: string;
  }>`SELECT id FROM schema_migration`.execute(db);
  return new Set(result.rows.map((row) => row.id));
}

export class MalformedMigrationError extends Error {
  readonly code = "persistence.migration.malformed";
  constructor(
    readonly id: string,
    reason: string,
  ) {
    super(`Migration ${id} ${reason}`);
    this.name = "MalformedMigrationError";
  }
}

export class IrreversibleMigrationError extends Error {
  readonly code = "persistence.migration.irreversible";
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(
      `Migration ${id} is irreversible and cannot be rolled back: ${reason}. The fix is forward.`,
    );
    this.name = "IrreversibleMigrationError";
  }
}
