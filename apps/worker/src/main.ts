/**
 * The worker process (New-18).
 *
 * Same image as the API, different command (RFC-BaaS §3.3), so a worker deploy
 * cannot be running different code from the API it shares a database with.
 *
 * It does **not** run migrations. Two processes racing the same migration on a
 * deploy is a lock contention bug that only appears under load; the API owns
 * the schema and the worker waits for it.
 */
import {
  SystemClock,
  UuidV7Generator,
  createLogger,
  loadConfig,
} from "@baas/platform";
import {
  TenantScope,
  TenantScopedCallRecorder,
  createDatabase,
} from "@baas/persistence";
import type { Database } from "@baas/persistence";
import {
  buildProviders,
  refuseIncompleteProviders,
} from "@baas/provider-registry";
import { buildWorker } from "./bootstrap.js";

/* c8 ignore start -- process wiring, exercised by running the app */
const clock = new SystemClock();
const config = loadConfig(process.env, { clock });
const logger = createLogger({
  service: `${config.global.observability.serviceName}-worker`,
  environment: config.global.appEnv,
  level: config.global.logLevel,
  additionalFields: [
    "tenantSlug",
    "accounts",
    "projected",
    "failed",
    "jobs",
    "deleted",
  ],
});

const db = createDatabase<Database>(config.global.database);

/** How often the loop wakes. Job intervals are declared per job, not here. */
const TICK_MS = 1_000;

async function start(): Promise<void> {
  const slug = config.global.bootstrapTenantSlug;
  const tenant = await db
    .selectFrom("tenant")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (tenant === undefined) {
    throw new Error(`no tenant row for slug "${slug}"`);
  }

  // The recorder is built here rather than inside the composition root
  // because both processes need the same one and both build their adapters
  // before the graph exists. Every provider call in either is written down.
  const ids = new UuidV7Generator();
  const providers = buildProviders({
    providers: config.tenants.get(slug)?.providers ?? {},
    clock,
    recorder: new TenantScopedCallRecorder({
      scope: new TenantScope(db),
      tenantId: tenant.id,
      clock,
      ids,
      logger,
    }),
  });
  refuseIncompleteProviders(config.global.appEnv, providers);

  const worker = buildWorker({
    db,
    logger,
    clock,
    ids,
    tenantId: tenant.id,
    providers,
  });

  // An object rather than a `let`: the signal handler assigns from a closure,
  // and a boolean local narrows to `true` for the loop condition.
  const state = { running: true };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ operationId: signal }, "shutting down");
      state.running = false;
    });
  }

  logger.info({ tenantSlug: slug, jobs: worker.jobs.length }, "worker started");

  // A tick in flight is allowed to finish before the loop exits: killing a
  // projection mid-pass leaves the read model partly written, and the whole
  // point of a rebuildable projection is that nobody has to reason about that.
  while (state.running) {
    await worker.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  await db.destroy();
  process.exit(0);
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
/* c8 ignore stop */
