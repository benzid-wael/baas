/**
 * `pnpm db:types` — regenerate the database types from a migrated database.
 *
 * Starts its own PostgreSQL, applies every migration, introspects, writes the
 * module, and stops. **No developer has to provide a server**: a generator you
 * can only run if you already have the right database running is a generator
 * that gets run rarely and then argued with.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "prettier";
import { introspectForCodegen, renderSchemaModule } from "./codegen.js";
import { startDatabase } from "./harness.js";

/* c8 ignore start -- a command, exercised by running it */
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const OUTPUT = join(import.meta.dirname, "..", "src", "schema.generated.ts");

const harness = await startDatabase({ migrationsDir: MIGRATIONS });
try {
  const tables = await introspectForCodegen(harness.db);
  // Formatted here rather than left to `pnpm format`, so the output is
  // canonical: the drift test compares bytes, and a file that only becomes
  // correct after a separate step would fail on a clean checkout.
  const rendered = await format(renderSchemaModule(tables), {
    parser: "typescript",
  });
  writeFileSync(OUTPUT, rendered, "utf8");
  process.stdout.write(
    `Wrote ${OUTPUT} from ${tables.length.toString()} tables.\n`,
  );
} finally {
  await harness.stop();
}
/* c8 ignore stop */
