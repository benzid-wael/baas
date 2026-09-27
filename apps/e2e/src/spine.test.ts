import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { Inbox, Outbox } from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { uuidv7 } from "uuidv7";
import { Simulator, signKeel } from "@baas/provider-sim";
import type { SimRoute } from "@baas/provider-sim";
import { Dispatcher } from "@baas/worker";
import { Reconciler } from "@baas/worker";
import { WEBHOOK_INBOX, WEBHOOK_VERIFIER, WebhookController } from "@baas/api";
import type { WebhookVerifier } from "@baas/api";

/**
 * The spine, end to end (finding C2, finding A7).
 *
 * This is the assertion the whole of M0 exists to make possible, and the one
 * the incumbent cannot make at all: an effect is enqueued, a worker dispatches
 * it, the partner calls back, the delivery lands in `provider_inbox`, and the
 * reconciler settles the effect — with no partner sandbox, no Docker daemon
 * and no operator.
 *
 * `keel_webhook_event` has never contained a row in the incumbent's
 * development environment. Here the row is the test.
 */
const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const START = parseInstant("2026-09-26T12:00:00.000Z");
const TENANT = uuidv7();

const { privateKey: KEEL_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let harness: DatabaseHarness;
let app: INestApplication;
let inbox: Inbox;
let outbox: Outbox;
let simulator: Simulator;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 100 }, () => uuidv7()));
}

const PAYOUT_ROUTE: SimRoute = {
  provider: "keel",
  method: "POST",
  path: "/keel/payouts",
  signed: false,
  handle: () => ({
    status: 202,
    body: { reference: "KEEL-REF-1" },
    accepted: {
      reference: "KEEL-REF-1",
      eventType: "payout.status",
      states: { accepted: "accepted", settled: "settled" },
    },
  }),
};

const verifier: WebhookVerifier = {
  verify: (_provider, rawBody, headers) =>
    headers["x-digital-signature"] === signKeel(rawBody, KEEL_KEY),
  tenantFor: (provider) => (provider === "keel" ? TENANT : undefined),
  interpret: (payload) => {
    const event = payload as {
      eventId?: string;
      eventType?: string;
      reference?: string;
    };
    return {
      externalEventId: event.eventId ?? null,
      eventType: event.eventType ?? null,
      providerRef: event.reference ?? null,
    };
  },
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
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  inbox = new Inbox(harness.db, new TestClock(START), ids());
  outbox = new Outbox(harness.db, new TestClock(START), ids());

  simulator = new Simulator({
    clock: new TestClock(START),
    ids: ids(),
    credentials: { keelPrivateKeyPem: KEEL_KEY, ruyaSecret: "unused" },
    targets: { keel: "http://localhost/webhooks/keel" },
    routes: [PAYOUT_ROUTE],
  });

  @Module({
    controllers: [WebhookController],
    providers: [
      { provide: WEBHOOK_INBOX, useFactory: () => inbox },
      { provide: WEBHOOK_VERIFIER, useValue: verifier },
    ],
  })
  class WebhookModule {}

  app = await NestFactory.create(WebhookModule, { logger: false });
  await app.init();
}, 120_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

describe("an effect settles without an operator", () => {
  it("enqueue → dispatch → webhook → inbox → reconcile", async () => {
    // 1. The application records the effect. No provider call happens here.
    const effectId = await outbox.enqueue(harness.db, {
      tenantId: TENANT,
      aggregateType: "payment_order",
      aggregateId: uuidv7(),
      providerId: "keel",
      operation: "payout.uk_domestic",
      payload: { amount: "10.00", currency: "AED" },
    });

    // 2. The worker dispatches it to the partner, which accepts with a 202.
    const dispatcher = new Dispatcher({
      outbox,
      logger,
      workerId: "worker-1",
      providers: new Map([
        [
          "keel",
          {
            send: () => {
              const result = simulator.handle(
                "POST",
                "/keel/payouts",
                {},
                JSON.stringify({ amount: "10.00" }),
              );
              const body = result.body as { reference: string };
              // The partner's callbacks are delivered below, as they would be
              // over the network.
              pendingDeliveries.push(
                ...result.deliveries.map((d) => d.request),
              );
              return Promise.resolve({
                kind: "accepted" as const,
                providerRef: body.reference,
              });
            },
          },
        ],
      ]),
    });

    const pendingDeliveries: {
      body: string;
      headers: Record<string, string>;
    }[] = [];
    const run = await dispatcher.runOnce();
    expect(run).toMatchObject({ claimed: 1, accepted: 1 });

    const dispatched = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .where("id", "=", effectId)
      .executeTakeFirstOrThrow();
    expect(dispatched.state).toBe("dispatched");
    expect(dispatched.provider_ref).toBe("KEEL-REF-1");

    // 3. The partner calls back. The row in provider_inbox is the assertion
    //    that C2 is closed.
    expect(pendingDeliveries).toHaveLength(1);
    const delivery = pendingDeliveries[0];
    const response = await request(server())
      .post("/webhooks/keel")
      .set(delivery?.headers ?? {})
      .send(delivery?.body ?? "");
    expect(response.status).toBe(202);

    const received = await harness.db
      .selectFrom("provider_inbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(received.signature_verified).toBe(true);
    expect(received.provider_ref).toBe("KEEL-REF-1");
    expect(received.processed_at).toBeNull();

    // 4. The reconciler settles the effect from the recorded evidence.
    const reconciler = new Reconciler({
      inbox,
      outbox,
      logger,
      interpret: (payload) => {
        const event = payload as { reference: string; state: string };
        return { providerRef: event.reference, state: event.state };
      },
      lookup: async (providerRef) => {
        const row = await harness.db
          .selectFrom("effect_outbox")
          .select(["id", "state"])
          .where("provider_ref", "=", providerRef)
          .executeTakeFirst();
        return row === undefined ? undefined : { id: row.id, state: row.state };
      },
    });

    expect(await reconciler.runOnce()).toMatchObject({ applied: 1 });

    const settled = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .where("id", "=", effectId)
      .executeTakeFirstOrThrow();
    expect(settled.state).toBe("confirmed");
  }, 60_000);

  it("records a forged webhook without acting on it", async () => {
    const body = JSON.stringify({
      eventId: "forged-1",
      eventType: "payout.status",
      reference: "KEEL-REF-1",
      state: "settled",
    });

    const response = await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": "not-a-signature",
      })
      .send(body);

    // 202 regardless: telling a caller its signature was wrong tells an
    // attacker the same thing, and a partner retrying on non-2xx would retry
    // a bad signature forever.
    expect(response.status).toBe(202);

    const forged = await harness.db
      .selectFrom("provider_inbox")
      .selectAll()
      .where("external_event_id", "=", "forged-1")
      .executeTakeFirstOrThrow();
    expect(forged.signature_verified).toBe(false);

    // ...and it is never offered to the reconciler.
    const pending = await inbox.pending(10);
    expect(pending.map((row) => row.external_event_id)).not.toContain(
      "forged-1",
    );
  });

  it("ignores an unknown provider without disclosing which exist", async () => {
    const response = await request(server()).post("/webhooks/ghost").send("{}");
    expect(response.status).toBe(202);
    const rows = await harness.db
      .selectFrom("provider_inbox")
      .selectAll()
      .where("provider_id", "=", "ghost")
      .execute();
    expect(rows).toEqual([]);
  });
});
