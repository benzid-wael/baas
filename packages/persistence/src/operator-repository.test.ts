import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { Duration } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { TenantScope } from "./tenant-scope.js";
import {
  OperatorRepository,
  ROLE_ADMIN,
  ROLE_APPROVER,
} from "./operator-repository.js";

const ACME = uuidv7();
const RIVAL = uuidv7();
const START = parseInstant("2026-09-27T19:00:00.000Z");

let harness: DatabaseHarness;
let scope: TenantScope;
let operators: OperatorRepository;
let clock: TestClock;

const IDENTITY = {
  issuer: "https://idp.test",
  subject: "operator-1",
  email: "ops@example.com",
  displayName: "An Operator",
};

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);
  for (const [id, slug] of [
    [ACME, "acme"],
    [RIVAL, "rival"],
  ] as const) {
    await harness.db
      .insertInto("tenant")
      .values({ id, slug, name: slug, created_at: toJsDate(START) })
      .execute();
  }
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  clock = new TestClock(START);
  operators = new OperatorRepository(
    clock,
    new SequenceIdGenerator(Array.from({ length: 400 }, () => uuidv7())),
  );
  await harness.db.deleteFrom("operator_session").execute();
  await harness.db.deleteFrom("operator_role").execute();
  await harness.db.deleteFrom("operator").execute();
});

const register = (identity = IDENTITY, tenant = ACME) =>
  scope.run(tenant, (db) => operators.upsert(db, tenant, identity));

describe("registering an operator", () => {
  it("creates one on first sign-in and updates their details after", async () => {
    const first = await register();
    const second = await register({ ...IDENTITY, displayName: "Renamed" });
    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Renamed");
  });

  it("grants no role at all on registration", async () => {
    // Authority is granted by a person, not by the identity provider's
    // say-so. A new operator can authenticate and do nothing.
    const operator = await register();
    expect(
      await scope.run(ACME, (db) => operators.rolesOf(db, operator.id)),
    ).toEqual([]);
  });

  it("treats the same subject from a different issuer as a different person", async () => {
    // Assuming otherwise is how a test identity provider becomes a way in.
    const real = await register();
    const impostor = await register({
      ...IDENTITY,
      issuer: "https://idp.evil",
    });
    expect(impostor.id).not.toBe(real.id);
  });
});

describe("sessions", () => {
  it("issues a token that resolves, and never stores it", async () => {
    const operator = await register();
    const { token } = await scope.run(ACME, (db) =>
      operators.issueSession(db, ACME, operator.id),
    );

    const resolved = await operators.resolveSession(harness.db, token);
    expect(resolved).toMatchObject({ operatorId: operator.id, tenantId: ACME });

    // A leaked database must not be a set of live sessions.
    const rows = await harness.db
      .selectFrom("operator_session")
      .selectAll()
      .execute();
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("refuses a token that was never issued", async () => {
    await register();
    expect(
      await operators.resolveSession(harness.db, "made-up"),
    ).toBeUndefined();
  });

  it("refuses an expired session", async () => {
    const operator = await register();
    const { token } = await scope.run(ACME, (db) =>
      operators.issueSession(db, ACME, operator.id, Duration.ofHours(1)),
    );
    clock.advanceBy(Duration.ofHours(1).plus(Duration.ofMinutes(1)));
    expect(await operators.resolveSession(harness.db, token)).toBeUndefined();
  });

  it("stops working the moment the session is revoked", async () => {
    const operator = await register();
    const { token } = await scope.run(ACME, (db) =>
      operators.issueSession(db, ACME, operator.id),
    );
    const live = await operators.resolveSession(harness.db, token);
    await operators.revokeSession(harness.db, live!.sessionId);
    expect(await operators.resolveSession(harness.db, token)).toBeUndefined();
  });

  it("stops working the moment the operator is disabled", async () => {
    // This is why sessions are server-side. A stateless token would keep
    // working until it expired, and this console reads any customer in the
    // tenant.
    const operator = await register();
    const { token } = await scope.run(ACME, (db) =>
      operators.issueSession(db, ACME, operator.id),
    );
    await scope.run(ACME, (db) =>
      db
        .updateTable("operator")
        .set({ disabled_at: toJsDate(clock.now()) })
        .where("id", "=", operator.id)
        .execute(),
    );
    expect(await operators.resolveSession(harness.db, token)).toBeUndefined();
  });

  it("revokes every session an operator holds at once", async () => {
    const operator = await register();
    const tokens = await Promise.all([
      scope.run(ACME, (db) => operators.issueSession(db, ACME, operator.id)),
      scope.run(ACME, (db) => operators.issueSession(db, ACME, operator.id)),
    ]);
    expect(
      await scope.run(ACME, (db) => operators.revokeAllFor(db, operator.id)),
    ).toBe(2);
    for (const { token } of tokens) {
      expect(await operators.resolveSession(harness.db, token)).toBeUndefined();
    }
  });

  it("carries the operator's roles, so a guard needs no second query", async () => {
    const operator = await register();
    await scope.run(ACME, (db) =>
      operators.grantRole(db, ACME, {
        operatorId: operator.id,
        role: ROLE_APPROVER,
        grantedBy: null,
        reason: "initial",
      }),
    );
    const { token } = await scope.run(ACME, (db) =>
      operators.issueSession(db, ACME, operator.id),
    );
    expect((await operators.resolveSession(harness.db, token))?.roles).toEqual([
      ROLE_APPROVER,
    ]);
  });
});

describe("roles", () => {
  it("grants once, idempotently", async () => {
    const operator = await register();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await scope.run(ACME, (db) =>
        operators.grantRole(db, ACME, {
          operatorId: operator.id,
          role: ROLE_ADMIN,
          grantedBy: null,
          reason: "initial",
        }),
      );
    }
    expect(
      await scope.run(ACME, (db) => operators.rolesOf(db, operator.id)),
    ).toEqual([ROLE_ADMIN]);
  });

  it("keeps a revoked grant in history and frees the role to be re-granted", async () => {
    const operator = await register();
    const grant = {
      operatorId: operator.id,
      role: ROLE_APPROVER,
      grantedBy: null,
      reason: "initial",
    };
    await scope.run(ACME, (db) => operators.grantRole(db, ACME, grant));
    await scope.run(ACME, (db) =>
      db
        .updateTable("operator_role")
        .set({ revoked_at: toJsDate(clock.now()) })
        .where("operator_id", "=", operator.id)
        .execute(),
    );
    await scope.run(ACME, (db) =>
      operators.grantRole(db, ACME, { ...grant, reason: "re-granted" }),
    );

    expect(
      await scope.run(ACME, (db) => operators.rolesOf(db, operator.id)),
    ).toEqual([ROLE_APPROVER]);
    const history = await harness.db
      .selectFrom("operator_role")
      .selectAll()
      .execute();
    expect(history).toHaveLength(2);
  });

  it("isolates operators by tenant", async () => {
    await register();
    expect(
      await scope.run(RIVAL, (db) =>
        db.selectFrom("operator").selectAll().execute(),
      ),
    ).toEqual([]);
  });
});
