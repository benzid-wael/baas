import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { SystemClock } from "@baas/platform";
import { loadMigrations, migrateUp } from "./migrator.js";
import type { MigratableDatabase } from "./migrator.js";
import type { Database } from "./schema.js";

/**
 * A real PostgreSQL for tests, started by the test run itself.
 *
 * Review finding E1: 33 persistence specs skip without a database URL and 521
 * tests skip in the default loop — and the layer not exercised by default is
 * the layer where the quarter's real defects lived. The fix is not a better
 * message when the database is missing; it is that the database cannot be
 * missing.
 *
 * **Why not Testcontainers.** A harness that needs a Docker daemon running is
 * a harness that gets skipped, and that is precisely how the incumbent arrived
 * at 521 skipped tests. `embedded-postgres` downloads and runs the real
 * PostgreSQL binaries with no daemon, no socket and no context configuration,
 * so `pnpm test` works on a laptop that has never installed Docker and on a CI
 * agent that cannot run Docker-in-Docker.
 *
 * **Why not an in-memory emulation.** `pg-mem` and its kind would reintroduce
 * exactly the defect class this exists to catch: the incumbent's JSONB
 * round-trip bug and its raw-SQL-only column are both things an emulation
 * would have accepted.
 *
 * **Reversibility.** Everything below the `DatabaseHarness` interface is one
 * implementation. `DATABASE_URL` already selects an external server instead,
 * which is the same seam Testcontainers would plug into.
 */
export interface DatabaseHarness {
  readonly db: Kysely<Database>;
  readonly url: string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  readonly migrationsDir: string;
  /** Use an already-running server instead of starting one. */
  readonly databaseUrl?: string | undefined;
  readonly port?: number;
}

/**
 * Vitest runs test files in parallel workers, each starting its own server, so
 * a shared counter collides across workers. A random high port with a bounded
 * retry is simpler than coordinating between processes.
 */
function randomPort(): number {
  return 50_000 + Math.floor(Math.random() * 12_000);
}

export async function startDatabase(
  options: HarnessOptions,
): Promise<DatabaseHarness> {
  const external = options.databaseUrl ?? process.env["DATABASE_URL"];
  return external === undefined
    ? startEmbedded(options)
    : startExternal(external, options);
}

async function startEmbedded(
  options: HarnessOptions,
): Promise<DatabaseHarness> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = mkdtempSync(join(tmpdir(), "baas-pg-"));
  const database = "baas_test";

  let server: InstanceType<typeof EmbeddedPostgres> | undefined;
  let port = options.port ?? randomPort();
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "baas",
      password: "baas",
      port,
      persistent: false,
    });
    try {
      if (attempt === 0) {
        await candidate.initialise();
      }
      await candidate.start();
      server = candidate;
      break;
    } catch (error) {
      lastError = error;
      port = randomPort();
    }
  }

  if (server === undefined) {
    throw new Error(
      `Could not start PostgreSQL after 5 attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  await server.createDatabase(database);

  const started = server;
  const url = `postgres://baas:baas@127.0.0.1:${port.toString()}/${database}`;
  const db = await connectAndMigrate(url, options.migrationsDir);

  return {
    db,
    url,
    stop: async () => {
      await db.destroy();
      await started.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startExternal(
  url: string,
  options: HarnessOptions,
): Promise<DatabaseHarness> {
  const db = await connectAndMigrate(url, options.migrationsDir);
  return { db, url, stop: () => db.destroy() };
}

async function connectAndMigrate(
  url: string,
  migrationsDir: string,
): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
  });
  // Kysely's schema generic is invariant, so a wider `Database` is not
  // assignable to the narrower shape the migrator needs. The narrowing is
  // explicit and lives at this one seam rather than being smeared through the
  // migrator as `never`.
  await migrateUp(
    db as unknown as Kysely<MigratableDatabase>,
    loadMigrations(migrationsDir),
    new SystemClock(),
  );
  return db;
}
