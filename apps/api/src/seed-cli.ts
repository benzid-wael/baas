/**
 * `pnpm seed` — bring an empty database up to the point the service starts.
 *
 * A separate entrypoint rather than a flag on the API, because it mints a
 * credential and prints it. Something that prints a secret should be something
 * a person ran on purpose.
 */
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
import { SeedRefusedError, seed } from "./seed.js";

/* c8 ignore start -- process wiring, exercised by running the command */
const clock = new SystemClock();
const config = loadConfig(process.env, { clock });
const logger = createLogger({
  service: "seed",
  environment: config.global.appEnv,
  level: config.global.logLevel,
  additionalFields: ["tenantSlug", "applied"],
});

const db = createDatabase<Database>(config.global.database);

async function main(): Promise<void> {
  // **Before touching the database.** Running it found the defect this guards:
  // the first version migrated and then refused, so a seed aimed at the wrong
  // environment applied schema changes before saying no. A command that
  // refuses should refuse having done nothing.
  if (config.global.appEnv !== "dev") {
    throw new SeedRefusedError(config.global.appEnv);
  }

  const result = await migrateUp(
    db as unknown as Kysely<MigratableDatabase>,
    loadMigrations(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "persistence",
        "migrations",
      ),
    ),
    clock,
  );
  logger.info({ applied: result.applied.length }, "migrations applied");

  const slug = config.global.bootstrapTenantSlug;
  const outcome = await seed(db, clock, new UuidV7Generator(), {
    appEnv: config.global.appEnv,
    tenantSlug: slug,
    tenantName: process.env["BOOTSTRAP_TENANT_NAME"] ?? slug,
    clientId: process.env["SEED_CLIENT_ID"] ?? "bff",
    scopes: ["mobile:accounts", "mobile:transactions"],
  });

  logger.info({ tenantSlug: slug }, "tenant ready");

  // Printed to stdout rather than logged: the logger's field allow-list would
  // drop it, and it *should* — a secret in a log line is a secret in a log
  // aggregator. This goes to the terminal of the person who ran the command.
  if (outcome.clientSecret !== undefined) {
    process.stdout.write(
      [
        "",
        "  An API client was created. This secret is shown once.",
        "",
        `    X-SC-CLIENT-ID:     ${process.env["SEED_CLIENT_ID"] ?? "bff"}`,
        `    X-SC-CLIENT-SECRET: ${outcome.clientSecret}`,
        "",
        "  Scopes: mobile:accounts, mobile:transactions",
        "",
      ].join("\n"),
    );
  } else {
    process.stdout.write(
      "\n  The API client already exists; its secret is not recoverable.\n  Delete the row and re-run to mint a new one.\n\n",
    );
  }

  await db.destroy();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "seed failed");
  process.exit(1);
});
/* c8 ignore stop */
