import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "reflect-metadata";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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
import type { ProviderCredentials } from "@baas/platform";
import { Inbox } from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { signKeel, signRuya } from "@baas/provider-sim";
import { buildWebhookVerifier } from "@baas/provider-registry";
import { WEBHOOK_INBOX, WEBHOOK_VERIFIER, WebhookController } from "@baas/api";

/**
 * Inbound provider callbacks (New-21).
 *
 * The signatures here are produced by `@baas/provider-sim`, which reproduces
 * the two partner schemes, and checked by the production verifier. Neither
 * side is a double, so a body accepted here is a body accepted from a partner.
 */
const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const START = parseInstant("2026-09-27T23:00:00.000Z");
const TENANT = uuidv7();
const RUYA_SECRET = "a-shared-secret-of-sufficient-length";

const { privateKey: KEEL_KEY, publicKey: KEEL_PUBLIC_KEY } =
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

let harness: DatabaseHarness;
let app: INestApplication;

function credentials(
  overrides: Partial<ProviderCredentials> & { provider: string },
): ProviderCredentials {
  return {
    baseUrl: "https://provider.invalid",
    clientId: "id",
    clientSecret: "secret",
    httpTimeoutMs: 10_000,
    tokenRefreshBufferSeconds: 60,
    maxRetries: 2,
    ...overrides,
  };
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/**
 * Every inbox row, newest last.
 *
 * Ordered by `id`, not `received_at`: the clock is fixed, so every row in this
 * file shares a timestamp and ordering by it returns rows in whatever order
 * the planner likes. The ids are uuidv7, so id order is insertion order.
 */
async function deliveries(): Promise<
  {
    provider_id: string;
    signature_verified: boolean;
    external_event_id: string | null;
  }[]
> {
  return harness.db
    .selectFrom("provider_inbox")
    .select(["provider_id", "signature_verified", "external_event_id"])
    .orderBy("id")
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
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  const inbox = new Inbox(
    harness.db,
    new TestClock(START),
    new SequenceIdGenerator(Array.from({ length: 200 }, () => uuidv7())),
  );

  const verifier = buildWebhookVerifier({
    providers: {
      keel: credentials({
        provider: "keel",
        webhookPublicKeyPem: KEEL_PUBLIC_KEY,
      }),
      ruya: credentials({
        provider: "ruya",
        callbackHmacSecret: RUYA_SECRET,
      }),
      // Declared, but with no callback credential: deliveries must be recorded
      // as unverified rather than accepted or dropped.
      uncredentialed: credentials({ provider: "uncredentialed" }),
    },
    tenantId: TENANT,
    logger,
  });

  @Module({
    controllers: [WebhookController],
    providers: [
      { provide: WEBHOOK_INBOX, useValue: inbox },
      { provide: WEBHOOK_VERIFIER, useValue: verifier },
    ],
  })
  class WebhookModule {}

  app = await NestFactory.create(WebhookModule, {
    logger: false,
    rawBody: true,
  });
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

describe("Keel callbacks", () => {
  it("accepts a correctly signed delivery and records it verified", async () => {
    const body = JSON.stringify({
      eventId: "keel-1",
      eventType: "payout.status",
      reference: "KEEL-REF-1",
    });
    const response = await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY),
      })
      .send(body);

    expect(response.status).toBe(202);
    const rows = await deliveries();
    expect(rows.at(-1)).toMatchObject({
      provider_id: "keel",
      signature_verified: true,
      external_event_id: "keel-1",
    });
  });

  it("prefers the notification-id header over the payload's own id", async () => {
    const body = JSON.stringify({ eventId: "in-the-body" });
    await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY),
        "x-webhook-notification-id": "in-the-header",
      })
      .send(body);
    expect((await deliveries()).at(-1)?.external_event_id).toBe(
      "in-the-header",
    );
  });

  it("ignores a notification id that is not printable ASCII", async () => {
    // Attacker-controlled, and it reaches a log line and a database column.
    const body = JSON.stringify({ eventId: "fallback" });
    await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY),
        "x-webhook-notification-id": "bad id with spaces",
      })
      .send(body);
    expect((await deliveries()).at(-1)?.external_event_id).toBe("fallback");
  });

  it("rejects a signature computed the outbound way", async () => {
    // Outbound signs `${rawBody}${idempotencyId}`; inbound signs the body
    // alone. Carrying the id across is the mistake this asserts against.
    const body = JSON.stringify({ eventId: "keel-wrong-formula" });
    await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY, "an-idempotency-id"),
      })
      .send(body);
    expect((await deliveries()).at(-1)?.signature_verified).toBe(false);
  });
});

describe("Ruya callbacks", () => {
  it("accepts a bare hex signature", async () => {
    const body = JSON.stringify({ eventId: "ruya-1", reference: "R-1" });
    const response = await request(server())
      .post("/webhooks/ruya")
      .set({
        "content-type": "application/json",
        "x-ruya-callback-signature": signRuya(body, RUYA_SECRET),
      })
      .send(body);
    expect(response.status).toBe(202);
    expect((await deliveries()).at(-1)?.signature_verified).toBe(true);
  });

  it("accepts the same signature with the sha256= prefix", async () => {
    const body = JSON.stringify({ eventId: "ruya-2" });
    await request(server())
      .post("/webhooks/ruya")
      .set({
        "content-type": "application/json",
        "x-ruya-callback-signature": `sha256=${signRuya(body, RUYA_SECRET)}`,
      })
      .send(body);
    expect((await deliveries()).at(-1)?.signature_verified).toBe(true);
  });

  it("does not accept the incumbent's `x-signature` fallback header", async () => {
    // Deliberately not carried over: a second accepted header name with no
    // stated reason is a second surface. See the open question in New-21.
    const body = JSON.stringify({ eventId: "ruya-3" });
    await request(server())
      .post("/webhooks/ruya")
      .set({
        "content-type": "application/json",
        "x-signature": signRuya(body, RUYA_SECRET),
      })
      .send(body);
    expect((await deliveries()).at(-1)?.signature_verified).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const body = JSON.stringify({ eventId: "ruya-4" });
    await request(server())
      .post("/webhooks/ruya")
      .set({
        "content-type": "application/json",
        "x-ruya-callback-signature": createHmac("sha256", "the-wrong-secret")
          .update(body)
          .digest("hex"),
      })
      .send(body);
    expect((await deliveries()).at(-1)?.signature_verified).toBe(false);
  });
});

describe("what verification refuses", () => {
  it("records a tampered body as unverified rather than dropping it", async () => {
    // Dropping it erases the only evidence that someone is probing, and makes
    // a misconfigured partner indistinguishable from a silent one.
    const signed = JSON.stringify({ eventId: "tampered", amount: "10.00" });
    const sent = JSON.stringify({ eventId: "tampered", amount: "1000.00" });
    const response = await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(signed, KEEL_KEY),
      })
      .send(sent);
    expect(response.status).toBe(202);
    expect((await deliveries()).at(-1)).toMatchObject({
      signature_verified: false,
      external_event_id: "tampered",
    });
  });

  it("records an unsigned delivery as unverified", async () => {
    await request(server())
      .post("/webhooks/keel")
      .set({ "content-type": "application/json" })
      .send(JSON.stringify({ eventId: "unsigned" }));
    expect((await deliveries()).at(-1)?.signature_verified).toBe(false);
  });

  it("fails closed for a provider with no callback credential", async () => {
    // Not an exception: the delivery is recorded as rejected, so a missing
    // credential shows up as rejected traffic rather than as silence.
    const body = JSON.stringify({ eventId: "no-credential" });
    const response = await request(server())
      .post("/webhooks/uncredentialed")
      .set({
        "content-type": "application/json",
        "x-ruya-callback-signature": signRuya(body, RUYA_SECRET),
      })
      .send(body);
    expect(response.status).toBe(202);
    expect((await deliveries()).at(-1)).toMatchObject({
      provider_id: "uncredentialed",
      signature_verified: false,
    });
  });

  it("records nothing at all for a provider this deployment does not serve", async () => {
    // Accepted anyway: telling a caller which provider ids exist is free
    // reconnaissance.
    const before = (await deliveries()).length;
    const response = await request(server())
      .post("/webhooks/someone-else")
      .set({ "content-type": "application/json" })
      .send(JSON.stringify({ eventId: "x" }));
    expect(response.status).toBe(202);
    expect((await deliveries()).length).toBe(before);
  });
});

describe("the raw bytes, not a re-serialisation", () => {
  it("verifies a body whose re-serialisation would differ", async () => {
    // This is the trap the old implementation fell into: it signed
    // `JSON.stringify(parsedBody)`. Key order and whitespace here differ from
    // anything `JSON.stringify` would produce, and the signature is over what
    // was actually sent -- so it must verify.
    const body = '{ "eventType":"payout.status" ,  "eventId" : "spaced-out" }';
    const response = await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY),
      })
      .send(body);

    expect(response.status).toBe(202);
    expect((await deliveries()).at(-1)).toMatchObject({
      signature_verified: true,
      external_event_id: "spaced-out",
    });
  });

  it("cannot yet record a delivery whose body is not JSON (New-22)", async () => {
    // Documenting the gap rather than pretending it is not there. The global
    // JSON parser answers 400 before the route runs, so a partner sending
    // malformed JSON leaves no inbox row -- and the 400 echoes the body back.
    // Both are wrong for a webhook endpoint and both are New-22.
    const before = (await deliveries()).length;
    const body = "this is not json";
    const response = await request(server())
      .post("/webhooks/keel")
      .set({
        "content-type": "application/json",
        "x-digital-signature": signKeel(body, KEEL_KEY),
      })
      .send(body);

    expect(response.status).toBe(400);
    expect((await deliveries()).length).toBe(before);
  });
});
