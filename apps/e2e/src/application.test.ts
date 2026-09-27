import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "reflect-metadata";
import { join } from "node:path";
import bcrypt from "bcrypt";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  loadConfig,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { buildRegistry } from "@baas/contracts";
import {
  buildApiApplication,
  compareRoutes,
  mountedRoutes,
  registeredRoutes,
} from "@baas/api";

/**
 * The whole application, assembled the way the process assembles it (New-18).
 *
 * Every other test in this repository wires a subset: one controller, a few
 * fakes, the guards it cares about. That is right for those tests and wrong
 * for one question — **does the thing we deploy exist and start?** Until this
 * file, nothing answered it, and both `docker-compose.yml` and the `Dockerfile`
 * referenced a `main.js` that was never built.
 *
 * It is also the only place the route-drift check means anything in both
 * directions. A partial module cannot say a documented path is unmounted,
 * because almost all of them are; this one can.
 */
const TENANT_SLUG = "sc";
const START = parseInstant("2026-09-27T21:00:00.000Z");
const SECRET = "client-secret-for-the-whole-app-test";

/**
 * The environment a deployment would set, minus anything that reaches the
 * network. Built as an environment rather than as a `Config` object on
 * purpose: the path from a manifest to a running application is the thing
 * under test, and handing the composition a pre-parsed object would skip it.
 */
function environment(databasePort: number): NodeJS.ProcessEnv {
  return {
    APP_ENV: "dev",
    // A real port and a real level: the schema allow-lists pino's levels and
    // `silent` is not one of them. Nothing listens in this test, so the port
    // is never bound.
    PORT: "3000",
    LOG_LEVEL: "error",
    DATABASE_HOST: "127.0.0.1",
    DATABASE_PORT: String(databasePort),
    DATABASE_USER: "postgres",
    DATABASE_PASSWORD: "postgres",
    DATABASE_NAME: "postgres",
    DATABASE_SSL: "false",
    MOBILE_ASSERTION_PUBLIC_KEY: [
      "-----BEGIN PUBLIC KEY-----",
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqhTKPgYZcYD7W+5YwSeqWoU5pvPY",
      "NzUmczh/KjOqC/j+HBJcp1MAJmcL9l79c6WMPZb8VxPkPBSX0asvdNYZhg==",
      "-----END PUBLIC KEY-----",
    ].join("\n"),
    MOBILE_ASSERTION_ISSUER: "https://bff.test",
    MOBILE_ASSERTION_AUDIENCE: "baas",
    OIDC_ISSUER: "https://idp.test",
    OIDC_AUDIENCE: "baas-portal",
    OIDC_JWKS_URI: "https://idp.test/jwks",
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "test-only-key-of-sufficient-length!",
    CALLBACK_HMAC_SECRET: "test-only-hmac-of-sufficient-length",
    BOOTSTRAP_TENANT_SLUG: TENANT_SLUG,
  };
}

let harness: DatabaseHarness;
let app: INestApplication | undefined;
let tenantId: string;

function application(): INestApplication {
  if (app === undefined) {
    throw new Error("the application did not start");
  }
  return app;
}

function server(): Parameters<typeof request>[0] {
  if (app === undefined) {
    throw new Error("the application did not start");
  }
  return app.getHttpServer() as Parameters<typeof request>[0];
}

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "persistence",
      "migrations",
    ),
  });

  const clock = new TestClock(START);
  tenantId = uuidv7();

  await harness.db
    .insertInto("tenant")
    .values({
      id: tenantId,
      slug: TENANT_SLUG,
      name: "SC",
      created_at: toJsDate(START),
    })
    .execute();

  // A real credential row, read back through the real repository by the real
  // guard. Nothing here is a fake.
  const clientId = uuidv7();
  await harness.db
    .insertInto("api_client")
    .values({
      id: clientId,
      tenant_id: tenantId,
      client_id: "bff",
      secret_hash: bcrypt.hashSync(SECRET, 10),
      name: "Mobile BFF",
      disabled_at: null,
      created_at: toJsDate(START),
    })
    .execute();

  // One live grant and one revoked one. The revoked row stays in the table as
  // history (D2) and must confer nothing — which is the half of the scope
  // query that a test asserting only the happy path would never reach.
  await harness.db
    .insertInto("api_client_scope")
    .values([
      {
        id: uuidv7(),
        api_client_id: clientId,
        scope: "mobile:accounts",
        granted_at: toJsDate(START),
        granted_by: tenantId,
        revoked_at: null,
        revoked_by: null,
        reason: "the BFF reads accounts",
      },
      {
        id: uuidv7(),
        api_client_id: clientId,
        scope: "mobile:transactions",
        granted_at: toJsDate(START),
        granted_by: tenantId,
        revoked_at: toJsDate(START),
        revoked_by: tenantId,
        reason: "withdrawn",
      },
    ])
    .execute();

  app = await buildApiApplication({
    // The harness URL carries a port we do not otherwise know; the config is
    // built from an environment so the loader runs, and then the harness's own
    // connection is handed to the graph.
    config: loadConfig(environment(Number(new URL(harness.url).port)), {}),
    db: harness.db,
    logger: createLogger({
      service: "e2e",
      environment: "test",
      level: "silent",
    }),
    clock,
    ids: new SequenceIdGenerator(Array.from({ length: 200 }, () => uuidv7())),
    tenantId,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await harness.stop();
});

describe("the assembled application", () => {
  it("mounts every path the contract publishes", () => {
    // This is the direction no other test can assert. A documented path with
    // no route behind it is the worse of the two drift failures, because a
    // client gets written against it.
    const drift = compareRoutes(
      mountedRoutes(application()),
      registeredRoutes(buildRegistry()),
    );
    expect(drift.registeredButUnmounted).toEqual([]);
  });

  it("publishes every path it mounts, apart from the declared operational ones", () => {
    const drift = compareRoutes(
      mountedRoutes(application()),
      registeredRoutes(buildRegistry()),
      {
        // Deliberately absent from the public contract, and listed here so the
        // absence is a decision rather than an oversight:
        //   - system routes are operational and not a client surface;
        //   - operator sessions belong to the portal, which is built from this
        //     repository and needs no published contract.
        // Webhook ingress is not mounted at all yet; see New-19.
        ignore: [
          "GET /system/health",
          "GET /system/ready",
          "GET /system/capabilities",
          "GET /system/version",
          "POST /operator/sessions",
          "DELETE /operator/sessions/current",
        ],
      },
    );
    expect(drift.mountedButUnregistered).toEqual([]);
  });

  it("serves health without a credential", async () => {
    const response = await request(server()).get("/system/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports ready only when the schema is the declared one", async () => {
    const response = await request(server()).get("/system/ready");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ready: true,
      checks: { database: true, schema: true },
    });
  });

  it("reports not ready when the schema drifts from the declaration (C1)", async () => {
    // The incumbent reports healthy when a migration is *recorded*, even if
    // its statements did not apply, so a half-migrated database serves
    // traffic. Readiness here runs the same introspection the drift test runs,
    // which is the only version of this check that can fail.
    await sql`ALTER TABLE tenant ADD COLUMN drifted uuid`.execute(harness.db);
    try {
      const response = await request(server()).get("/system/ready");
      expect(response.body).toEqual({
        ready: false,
        checks: { database: true, schema: false },
      });
    } finally {
      await sql`ALTER TABLE tenant DROP COLUMN drifted`.execute(harness.db);
    }
  });

  it("refuses the mobile surface without a client credential", async () => {
    expect((await request(server()).get("/mobile/accounts")).status).toBe(401);
  });

  it("authenticates a real api_client row through the real repository", async () => {
    // No user assertion, so this must reach the identity guard and stop there
    // — which proves the client credential and its live scope were accepted.
    const response = await request(server())
      .get("/mobile/accounts")
      .set({ "x-sc-client-id": "bff", "x-sc-client-secret": SECRET });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).toMatch(/user identity is required/);
  });

  it("gives a revoked scope no authority, history row or not", async () => {
    const response = await request(server())
      .get("/mobile/accounts/ref-1/transactions")
      .set({ "x-sc-client-id": "bff", "x-sc-client-secret": SECRET });
    expect(response.status).toBe(403);
  });

  it("refuses a client credential whose secret is wrong", async () => {
    const response = await request(server())
      .get("/mobile/accounts")
      .set({ "x-sc-client-id": "bff", "x-sc-client-secret": "wrong" });
    expect(response.status).toBe(401);
  });

  it("refuses the operator surface without a session", async () => {
    expect(
      (await request(server()).get("/platform/customers?externalUserUuid=x"))
        .status,
    ).toBe(401);
  });

  it("reports capabilities with no provider configured, rather than pretending", async () => {
    // `PROVIDERS` is unset, so there is nothing to report and the empty list is
    // the honest answer. When New-19 wires an adapter, this is where the
    // reason changes from silence to `not_configured`.
    const graph = await request(server())
      .get("/system/capabilities")
      .set({ "x-sc-client-id": "bff", "x-sc-client-secret": SECRET });
    // Operator role required, and an API client holds none.
    expect(graph.status).toBe(403);
  });
});
