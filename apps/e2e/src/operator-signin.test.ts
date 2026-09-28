import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { uuidv7 } from "uuidv7";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import {
  OperatorRepository,
  ROLE_ADMIN,
  ROLE_APPROVER,
  TenantScope,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import {
  AuthorizationPolicyGuard,
  OPERATOR_SESSIONS,
  OidcVerifier,
  OperatorSessionController,
  OperatorSessionGuard,
  OperatorSurface,
  Roles,
  RolesGuard,
  StaticKeySource,
} from "@baas/api";

const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const TENANT = uuidv7();
const START = parseInstant("2026-09-27T20:00:00.000Z");
const ISSUER = "https://idp.test";
const AUDIENCE = "baas-portal";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let harness: DatabaseHarness;
let app: INestApplication;
let operators: OperatorRepository;
let scope: TenantScope;

@Controller("platform")
class ProbeController {
  @Get("anyone")
  @OperatorSurface()
  @Roles("operator", "admin")
  anyone(): { ok: true } {
    return { ok: true };
  }

  @Get("approve")
  @OperatorSurface()
  @Roles(ROLE_APPROVER)
  approve(): { ok: true } {
    return { ok: true };
  }
}

function idToken(
  subject: string,
  claims: Record<string, unknown> = {},
): string {
  return jwt.sign({ sub: subject, ...claims }, privateKey, {
    algorithm: "RS256",
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "5m",
  });
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

async function signIn(subject: string): Promise<string> {
  const response = await request(server())
    .post("/operator/sessions")
    .send({ idToken: idToken(subject, { email: `${subject}@example.com` }) });
  expect(response.status).toBe(201);
  return (response.body as { token: string }).token;
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
  operators = new OperatorRepository(
    clock,
    new SequenceIdGenerator(Array.from({ length: 900 }, () => uuidv7())),
  );
  scope = new TenantScope(harness.db);

  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  const deps = {
    verifier: new OidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE },
      new StaticKeySource(publicKey),
    ),
    operators,
    scope,
    db: harness.db,
    logger,
    tenantId: TENANT,
    bootstrapAdminSubjects: ["founder-a", "founder-b"],
  };

  @Module({
    controllers: [OperatorSessionController, ProbeController],
    providers: [
      { provide: OPERATOR_SESSIONS, useValue: deps },
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
  class OperatorModule {}

  app = await NestFactory.create(OperatorModule, {
    logger: false,
    // Nest aborts the process on an init failure and prints no message at
    // all. Rejecting instead means the next missing provider says so.
    abortOnError: false,
  });
  // Listening, not merely initialised (New-26).
  //
  // Supertest starts a server itself when handed one that is not listening,
  // and **closes it again once the request settles** -- a listen and a close
  // per request. A request dispatched while that close is in flight fails with
  // `socket hang up`, which is what made the suite fail about one run in four.
  // Once the server is already listening, supertest reuses the address and
  // never closes anything. `app.close()` in `afterAll` still shuts it down.
  await app.listen(0);
}, 180_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

beforeEach(async () => {
  await harness.db.deleteFrom("operator_session").execute();
  await harness.db.deleteFrom("operator_role").execute();
  await harness.db.deleteFrom("operator").execute();
});

describe("signing in", () => {
  it("exchanges a verified ID token for a session", async () => {
    const response = await request(server())
      .post("/operator/sessions")
      .send({ idToken: idToken("someone") });
    expect(response.status).toBe(201);
    expect((response.body as { token: string }).token).toMatch(/^[\w-]{40,}$/);
  });

  it("refuses a token it cannot verify, without saying why", async () => {
    // Telling a caller why a token was refused tells them how to make a
    // better one.
    const forged = jwt.sign({ sub: "someone" }, privateKey, {
      algorithm: "RS256",
      issuer: "https://idp.evil",
      audience: AUDIENCE,
      expiresIn: "5m",
    });
    const response = await request(server())
      .post("/operator/sessions")
      .send({ idToken: forged });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/issuer|jwt|idp\.evil/i);
  });

  it("requires an idToken in the body", async () => {
    expect(
      (await request(server()).post("/operator/sessions").send({})).status,
    ).toBe(400);
  });

  it("refuses a disabled operator", async () => {
    await signIn("someone");
    await scope.run(TENANT, (db) =>
      db
        .updateTable("operator")
        .set({ disabled_at: toJsDate(START) })
        .where("subject", "=", "someone")
        .execute(),
    );
    const response = await request(server())
      .post("/operator/sessions")
      .send({ idToken: idToken("someone") });
    expect(response.status).toBe(401);
  });
});

describe("what a session can do", () => {
  it("reaches nothing until a role is granted", async () => {
    // Registration deliberately grants no role: authority comes from a
    // person, not from the identity provider's say-so.
    const token = await signIn("newcomer");
    const response = await request(server())
      .get("/platform/anyone")
      .set({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(403);
  });

  it("reaches an operator route once granted", async () => {
    const token = await signIn("founder-a");
    expect(
      (
        await request(server())
          .get("/platform/anyone")
          .set({ authorization: `Bearer ${token}` })
      ).status,
    ).toBe(200);
  });

  it("is refused without a bearer token", async () => {
    expect((await request(server()).get("/platform/anyone")).status).toBe(401);
  });
});

describe("bootstrapping the first operator", () => {
  it("grants admin to a configured subject on first sign-in", async () => {
    await signIn("founder-a");
    const operator = await scope.run(TENANT, (db) =>
      db
        .selectFrom("operator")
        .selectAll()
        .where("subject", "=", "founder-a")
        .executeTakeFirstOrThrow(),
    );
    expect(
      await scope.run(TENANT, (db) => operators.rolesOf(db, operator.id)),
    ).toEqual([ROLE_ADMIN]);
  });

  it("grants it once, however many times they sign in", async () => {
    await signIn("founder-a");
    await signIn("founder-a");
    const rows = await harness.db
      .selectFrom("operator_role")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("records why the grant happened, so it is never invisible", async () => {
    await signIn("founder-a");
    const row = await harness.db
      .selectFrom("operator_role")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.reason).toBe("bootstrap from configuration");
  });

  it("grants nothing to a subject that is not configured", async () => {
    await signIn("someone-else");
    expect(
      await harness.db.selectFrom("operator_role").selectAll().execute(),
    ).toEqual([]);
  });

  it("seeds two, because dual control needs two people", async () => {
    // Finding C3: the incumbent deadlocked policy publishing, payment-order
    // approval and account-opening review because an environment had one
    // administrator.
    await signIn("founder-a");
    await signIn("founder-b");
    const admins = await harness.db
      .selectFrom("operator_role")
      .selectAll()
      .execute();
    expect(admins).toHaveLength(2);
    expect(new Set(admins.map((row) => row.operator_id)).size).toBe(2);
  });
});

describe("admin still does not satisfy approver (D1)", () => {
  it("refuses an approver-only route to an admin", async () => {
    const token = await signIn("founder-a");
    expect(
      (
        await request(server())
          .get("/platform/approve")
          .set({ authorization: `Bearer ${token}` })
      ).status,
    ).toBe(403);
  });

  it("allows it to an explicit approver", async () => {
    await signIn("founder-a");
    const operator = await scope.run(TENANT, (db) =>
      db
        .selectFrom("operator")
        .selectAll()
        .where("subject", "=", "founder-a")
        .executeTakeFirstOrThrow(),
    );
    await scope.run(TENANT, (db) =>
      operators.grantRole(db, TENANT, {
        operatorId: operator.id,
        role: ROLE_APPROVER,
        grantedBy: null,
        reason: "granted for the test",
      }),
    );
    // A new session, because roles are read when the session resolves.
    const fresh = await signIn("founder-a");
    expect(
      (
        await request(server())
          .get("/platform/approve")
          .set({ authorization: `Bearer ${fresh}` })
      ).status,
    ).toBe(200);
  });
});

describe("signing out", () => {
  it("revokes every session, not just this one", async () => {
    // Someone signing out of a console that reads any customer usually means
    // it, and "everywhere" is never the wrong interpretation.
    const first = await signIn("founder-a");
    const second = await signIn("founder-a");

    expect(
      (
        await request(server())
          .delete("/operator/sessions/current")
          .set({ authorization: `Bearer ${second}` })
      ).status,
    ).toBe(204);

    for (const token of [first, second]) {
      expect(
        (
          await request(server())
            .get("/platform/anyone")
            .set({ authorization: `Bearer ${token}` })
        ).status,
      ).toBe(401);
    }
  });
});
