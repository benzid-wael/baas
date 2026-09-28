import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import {
  ApiClientAdminRepository,
  AuditRepository,
  OperatorRepository,
  ROLE_ADMIN,
  TenantScope,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { ApiClientAdmin } from "@baas/application";
import {
  API_CLIENT_ADMIN,
  AuthorizationPolicyGuard,
  OPERATOR_READS,
  OperatorSessionGuard,
  PlatformReadController,
  RolesGuard,
  SYSTEM_READS,
} from "@baas/api";

/**
 * Granting and revoking an API client's scopes (MP-3, findings D2 and F2).
 *
 * Two halves of one defect. **D2**: the incumbent's `PATCH` replaces the scope
 * array wholesale and writes no audit row. **F2**: its portal cannot edit
 * scopes at all, so the change is made in the database instead. Fixing either
 * alone reproduces the other, so the assertions below cover both: every change
 * leaves a row, and **no route accepts a list**.
 */
const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const START = parseInstant("2026-09-28T15:00:00.000Z");
const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();

let harness: DatabaseHarness;
let app: INestApplication;
let scope: TenantScope;
let clientId: string;
let otherTenantClientId: string;
let adminToken: string;
let operatorToken: string;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 400 }, () => uuidv7()));
}

const asAdmin = (): Record<string, string> => ({
  authorization: `Bearer ${adminToken}`,
});
const asOperator = (): Record<string, string> => ({
  authorization: `Bearer ${operatorToken}`,
});

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

async function makeClient(tenantId: string, name: string): Promise<string> {
  const id = uuidv7();
  await harness.db
    .insertInto("api_client")
    .values({
      id,
      tenant_id: tenantId,
      client_id: name,
      secret_hash: "$2b$10$notarealhash",
      name,
      disabled_at: null,
      created_at: toJsDate(START),
    })
    .execute();
  return id;
}

async function grants(): Promise<
  { scope: string; revoked_at: Date | null; reason: string }[]
> {
  return harness.db
    .selectFrom("api_client_scope")
    .select(["scope", "revoked_at", "reason"])
    .where("api_client_id", "=", clientId)
    .orderBy("granted_at")
    .orderBy("id")
    .execute();
}

async function auditRows(): Promise<
  { action: string; actor_id: string | null; detail: unknown }[]
> {
  return harness.db
    .selectFrom("audit_event")
    .select(["action", "actor_id", "detail"])
    .orderBy("occurred_at")
    .execute();
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
  scope = new TenantScope(harness.db);

  for (const [id, slug] of [
    [TENANT, "sc"],
    [OTHER_TENANT, "other"],
  ] as const) {
    await harness.db
      .insertInto("tenant")
      .values({ id, slug, name: slug, created_at: toJsDate(START) })
      .execute();
  }

  clientId = await makeClient(TENANT, "bff");
  otherTenantClientId = await makeClient(OTHER_TENANT, "their-bff");

  const operators = new OperatorRepository(clock, ids());
  const admin = await scope.run(TENANT, (db) =>
    operators.upsert(db, TENANT, {
      issuer: "https://idp.test",
      subject: "admin-1",
    }),
  );
  await scope.run(TENANT, (db) =>
    operators.grantRole(db, TENANT, {
      operatorId: admin.id,
      role: ROLE_ADMIN,
      grantedBy: null,
      reason: "test",
    }),
  );
  adminToken = (
    await scope.run(TENANT, (db) =>
      operators.issueSession(db, TENANT, admin.id),
    )
  ).token;

  const plain = await scope.run(TENANT, (db) =>
    operators.upsert(db, TENANT, {
      issuer: "https://idp.test",
      subject: "ops-1",
    }),
  );
  await scope.run(TENANT, (db) =>
    operators.grantRole(db, TENANT, {
      operatorId: plain.id,
      role: "operator",
      grantedBy: null,
      reason: "test",
    }),
  );
  operatorToken = (
    await scope.run(TENANT, (db) =>
      operators.issueSession(db, TENANT, plain.id),
    )
  ).token;

  const apiClients = new ApiClientAdmin(
    scope,
    new ApiClientAdminRepository(clock, ids()),
    new AuditRepository(clock, ids()),
  );

  @Module({
    controllers: [PlatformReadController],
    providers: [
      { provide: API_CLIENT_ADMIN, useValue: apiClients },
      { provide: OPERATOR_READS, useValue: {} },
      { provide: SYSTEM_READS, useValue: {} },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) =>
          new OperatorSessionGuard(r, harness.db, operators, logger),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new RolesGuard(r),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new AuthorizationPolicyGuard(r, logger),
      },
    ],
  })
  class ScopeModule {}

  app = await NestFactory.create(ScopeModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0);
}, 180_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

beforeEach(async () => {
  // No `app.scope_admin` needed: the trigger guards INSERT and UPDATE, not
  // DELETE. There is still no DELETE *grant* for the application role — this
  // is the harness's own superuser connection cleaning up between tests.
  await harness.db.deleteFrom("api_client_scope").execute();
  await sql`TRUNCATE audit_event`.execute(harness.db);
});

const grant = (scopeName: string, reason = "the BFF needs it") =>
  request(server())
    .post(`/platform/api-clients/${clientId}/scopes`)
    .set(asAdmin())
    .send({ scope: scopeName, reason });

describe("granting a scope", () => {
  it("records it, with who and why", async () => {
    expect((await grant("mobile:accounts")).status).toBe(201);

    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "mobile:accounts",
      revoked_at: null,
      reason: "the BFF needs it",
    });
  });

  it("writes an audit row naming the operator", async () => {
    // Finding D2: the incumbent's PATCH writes none, so "who granted this"
    // has no answer.
    await grant("mobile:accounts");
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("api_client.scope_granted");
    expect(audit[0]?.actor_id).not.toBeNull();
  });

  it("refuses a reason that is not given", async () => {
    const response = await request(server())
      .post(`/platform/api-clients/${clientId}/scopes`)
      .set(asAdmin())
      .send({ scope: "mobile:accounts" });
    expect(response.status).toBe(400);
    expect(await grants()).toEqual([]);
  });

  it("refuses a scope this build does not understand", async () => {
    // A typo is accepted by any string column, shows as granted, and grants
    // nothing — the operator believes access was given.
    const response = await grant("mobile:account");
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("mobile:accounts");
    expect(await grants()).toEqual([]);
  });

  it("refuses a second live grant of the same scope", async () => {
    await grant("mobile:accounts");
    expect((await grant("mobile:accounts")).status).toBe(409);
    expect(await grants()).toHaveLength(1);
  });
});

describe("revoking a scope", () => {
  const revoke = (scopeName: string) =>
    request(server())
      .delete(`/platform/api-clients/${clientId}/scopes/${scopeName}`)
      .set(asAdmin());

  it("stamps the grant rather than deleting it", async () => {
    // A revoked grant is the only evidence that access once existed, which is
    // exactly what an audit asks about afterwards.
    await grant("mobile:accounts");
    expect((await revoke("mobile:accounts")).status).toBe(200);

    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it("audits the revocation", async () => {
    await grant("mobile:accounts");
    await revoke("mobile:accounts");
    expect((await auditRows()).map((row) => row.action)).toEqual([
      "api_client.scope_granted",
      "api_client.scope_revoked",
    ]);
  });

  it("records an attempt to revoke something that was not there", async () => {
    // Usually two people on the same client, or a stale screen. Worth seeing.
    const response = await revoke("mobile:accounts");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revoked: false });
    expect((await auditRows())[0]?.action).toBe("api_client.scope_revoked");
  });

  it("allows a re-grant afterwards, and the history shows all three", async () => {
    await grant("mobile:accounts", "first time");
    await revoke("mobile:accounts");
    await grant("mobile:accounts", "needed again");

    const rows = await grants();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ revoked_at: null, reason: "needed again" });

    const history = await request(server())
      .get(`/platform/api-clients/${clientId}/scopes`)
      .set(asOperator());
    const body = history.body as { grants: { live: boolean }[] };
    expect(body.grants).toHaveLength(2);
    expect(body.grants.filter((entry) => entry.live)).toHaveLength(1);
  });
});

describe("no route replaces a scope array wholesale", () => {
  it("has no PUT or PATCH on the scopes path", async () => {
    // Finding D2's actual mechanism: a request that omits a scope revokes it
    // silently, and two operators editing at once lose each other's work.
    for (const method of ["put", "patch"] as const) {
      const send = request(server())[method](
        `/platform/api-clients/${clientId}/scopes`,
      );
      const response = await send
        .set(asAdmin())
        .send({ scopes: ["mobile:accounts", "mobile:transactions"] });
      expect(response.status).toBe(404);
    }
  });

  it("ignores a body that tries to smuggle a list into a grant", async () => {
    const response = await request(server())
      .post(`/platform/api-clients/${clientId}/scopes`)
      .set(asAdmin())
      .send({ scopes: ["mobile:accounts"], reason: "sneaky" });
    expect(response.status).toBe(400);
    expect(await grants()).toEqual([]);
  });
});

describe("who may change a scope", () => {
  it("refuses an operator without admin", async () => {
    // Giving a credential access to customer data is a privilege change; the
    // role that reads is not the role that widens what can be read.
    const response = await request(server())
      .post(`/platform/api-clients/${clientId}/scopes`)
      .set(asOperator())
      .send({ scope: "mobile:accounts", reason: "please" });
    expect(response.status).toBe(403);
    expect(await grants()).toEqual([]);
  });

  it("lets an operator read the history", async () => {
    await grant("mobile:accounts");
    const response = await request(server())
      .get(`/platform/api-clients/${clientId}/scopes`)
      .set(asOperator());
    expect(response.status).toBe(200);
  });

  it("refuses everything without a session", async () => {
    expect((await request(server()).get("/platform/api-clients")).status).toBe(
      401,
    );
  });
});

describe("another tenant's clients", () => {
  it("are not listed", async () => {
    const response = await request(server())
      .get("/platform/api-clients")
      .set(asOperator());
    const body = response.body as { clients: { clientId: string }[] };
    expect(body.clients.map((client) => client.clientId)).toEqual(["bff"]);
  });

  it("cannot be granted a scope", async () => {
    // `api_client` carries no row policy — it cannot, because reading it is
    // how the tenant is established — so this is a WHERE clause, and it is the
    // only thing between an operator and another tenant's credentials.
    const response = await request(server())
      .post(`/platform/api-clients/${otherTenantClientId}/scopes`)
      .set(asAdmin())
      .send({ scope: "mobile:accounts", reason: "not mine" });
    expect(response.status).toBe(404);

    const theirs = await harness.db
      .selectFrom("api_client_scope")
      .selectAll()
      .where("api_client_id", "=", otherTenantClientId)
      .execute();
    expect(theirs).toEqual([]);
  });

  it("cannot have their history read", async () => {
    expect(
      (
        await request(server())
          .get(`/platform/api-clients/${otherTenantClientId}/scopes`)
          .set(asOperator())
      ).status,
    ).toBe(404);
  });
});
