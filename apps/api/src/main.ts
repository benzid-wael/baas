/**
 * The API process (New-18).
 *
 * Thin by design: everything interesting is in `bootstrap.ts`, which a test
 * can call. What is left here is the part that can only be exercised by
 * running the process — reading the environment, opening a pool, binding a
 * port, and shutting down when asked.
 */
import "reflect-metadata";
import {
  SystemClock,
  UuidV7Generator,
  createLogger,
  loadConfig,
} from "@baas/platform";
import { createDatabase, loadMigrations, migrateUp } from "@baas/persistence";
import type { Database, MigratableDatabase } from "@baas/persistence";
import type { Kysely } from "kysely";
import { join } from "node:path";
import { buildApiApplication } from "./bootstrap.js";

/* c8 ignore start -- process wiring, exercised by running the app */
const clock = new SystemClock();
const config = loadConfig(process.env, { clock });
const logger = createLogger({
  service: config.global.observability.serviceName,
  environment: config.global.appEnv,
  level: config.global.logLevel,
  additionalFields: ["port", "tenantSlug", "applied"],
});

const db = createDatabase<Database>(config.global.database);

/**
 * Migrations ship inside the image next to the compiled code, so this resolves
 * the same way whether the process runs from `apps/api/dist` on a laptop or in
 * the container.
 */
const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "persistence",
  "migrations",
);

async function start(): Promise<void> {
  if (config.global.database.migrationsRun) {
    const result = await migrateUp(
      db as unknown as Kysely<MigratableDatabase>,
      loadMigrations(MIGRATIONS_DIR),
      clock,
    );
    logger.info({ applied: result.applied.length }, "migrations applied");
  }

  // The tenant row is the source of the id; configuration names only a slug.
  // Failing here is correct: an API that cannot resolve its tenant cannot
  // scope a single query, and starting anyway would mean every request
  // discovers that separately.
  const slug = config.global.bootstrapTenantSlug;
  const tenant = await db
    .selectFrom("tenant")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (tenant === undefined) {
    throw new Error(`no tenant row for slug "${slug}"`);
  }

  const app = await buildApiApplication({
    config,
    db,
    logger,
    clock,
    ids: new UuidV7Generator(),
    tenantId: tenant.id,
  });

  const port = config.global.port;
  const host = config.global.bindHost;
  await (host === undefined ? app.listen(port) : app.listen(port, host));
  logger.info({ port, tenantSlug: slug }, "api listening");

  // Stop accepting connections, finish what is in flight, then close the pool.
  // A pool closed first would fail the requests that are still running, which
  // is a worse shutdown than not handling the signal at all.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ operationId: signal }, "shutting down");
      void app
        .close()
        .then(() => db.destroy())
        .then(() => process.exit(0));
    });
  }
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "api failed to start");
  process.exit(1);
});
/* c8 ignore stop */
