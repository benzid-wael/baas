import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import bcrypt from "bcrypt";
import { uuidv7 } from "uuidv7";
import { SequenceIdGenerator, TestClock, parseInstant } from "@baas/platform";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { SeedRefusedError, seed } from "@baas/api";

/**
 * Seeding a development environment (New-24).
 *
 * The thing under test is not really "a row appears". It is that a command
 * which **mints a credential** behaves the way such a command must: refused
 * outside dev, idempotent, and incapable of silently rotating a secret
 * somebody is already using.
 */
const START = parseInstant("2026-09-28T16:00:00.000Z");
let harness: DatabaseHarness;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 100 }, () => uuidv7()));
}

const request = {
  appEnv: "dev",
  tenantSlug: "sc",
  tenantName: "SC",
  clientId: "bff",
  scopes: ["mobile:accounts"],
};

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
}, 180_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.db.deleteFrom("api_client_scope").execute();
  await harness.db.deleteFrom("api_client").execute();
  await harness.db.deleteFrom("tenant").execute();
});

describe("seeding an empty database", () => {
  it("creates the tenant the service refuses to start without", async () => {
    const result = await seed(harness.db, new TestClock(START), ids(), request);
    expect(result.created).toBe(true);

    const tenant = await harness.db
      .selectFrom("tenant")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(tenant.slug).toBe("sc");
    expect(tenant.id).toBe(result.tenantId);
  });

  it("creates an API client whose secret is hashed, never stored in the clear", async () => {
    const result = await seed(harness.db, new TestClock(START), ids(), request);
    expect(result.clientSecret).toBeDefined();

    const client = await harness.db
      .selectFrom("api_client")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(client.secret_hash).not.toBe(result.clientSecret);
    expect(
      await bcrypt.compare(result.clientSecret ?? "", client.secret_hash),
    ).toBe(true);
  });

  it("grants the scopes as live grants", async () => {
    await seed(harness.db, new TestClock(START), ids(), request);
    const scopes = await harness.db
      .selectFrom("api_client_scope")
      .selectAll()
      .execute();
    expect(scopes.map((row) => row.scope)).toEqual(["mobile:accounts"]);
    expect(scopes[0]?.revoked_at).toBeNull();
  });

  it("generates a secret with real entropy, not a fixed one", async () => {
    const first = await seed(harness.db, new TestClock(START), ids(), request);
    await harness.db.deleteFrom("api_client_scope").execute();
    await harness.db.deleteFrom("api_client").execute();
    const second = await seed(harness.db, new TestClock(START), ids(), request);
    expect(second.clientSecret).not.toBe(first.clientSecret);
    expect((first.clientSecret ?? "").length).toBeGreaterThanOrEqual(40);
  });
});

describe("running it twice", () => {
  it("does not duplicate the tenant", async () => {
    await seed(harness.db, new TestClock(START), ids(), request);
    const again = await seed(harness.db, new TestClock(START), ids(), request);
    expect(again.created).toBe(false);
    expect(
      await harness.db.selectFrom("tenant").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("does NOT rotate an existing client's secret", async () => {
    // Re-running a seed to recover a lost secret would quietly make it a
    // credential-reset command, and the reset would happen to whoever was
    // using the old one. It says the secret is unrecoverable instead.
    const first = await seed(harness.db, new TestClock(START), ids(), request);
    const hashBefore = (
      await harness.db
        .selectFrom("api_client")
        .select("secret_hash")
        .executeTakeFirstOrThrow()
    ).secret_hash;

    const again = await seed(harness.db, new TestClock(START), ids(), request);
    expect(again.clientSecret).toBeUndefined();

    const hashAfter = (
      await harness.db
        .selectFrom("api_client")
        .select("secret_hash")
        .executeTakeFirstOrThrow()
    ).secret_hash;
    expect(hashAfter).toBe(hashBefore);
    expect(await bcrypt.compare(first.clientSecret ?? "", hashAfter)).toBe(
      true,
    );
  });
});

describe("where it refuses to run", () => {
  for (const appEnv of ["stage", "production"]) {
    it(`refuses ${appEnv}, and writes nothing`, async () => {
      await expect(
        seed(harness.db, new TestClock(START), ids(), { ...request, appEnv }),
      ).rejects.toThrow(SeedRefusedError);
      expect(
        await harness.db.selectFrom("tenant").selectAll().execute(),
      ).toEqual([]);
    });
  }

  it("says why, in terms of the decision rather than the rule", async () => {
    await expect(
      seed(harness.db, new TestClock(START), ids(), {
        ...request,
        appEnv: "production",
      }),
    ).rejects.toThrow(/mints an API client secret/);
  });
});
