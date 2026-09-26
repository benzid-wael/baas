import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
} from "@baas/platform";
import { createSimulatorServer } from "./server.js";
import { Simulator } from "./simulator.js";
import { signKeel } from "./signing.js";
import type { SignedRequest } from "./delivery.js";
import type { SimRoute } from "./routes.js";

const { privateKey: KEEL_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const PAYOUT: SimRoute = {
  provider: "keel",
  method: "POST",
  path: "/keel/payouts",
  signed: true,
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

const logger = createLogger({
  service: "test",
  environment: "test",
  level: "silent",
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(sent: SignedRequest[]): Promise<string> {
  const simulator = new Simulator({
    clock: new TestClock(parseInstant("2026-09-26T12:00:00.000Z")),
    ids: new SequenceIdGenerator(["ev-1", "ev-2"]),
    credentials: { keelPrivateKeyPem: KEEL_KEY, ruyaSecret: "s" },
    targets: { keel: "http://receiver.invalid/keel/webhooks" },
    routes: [PAYOUT],
  });
  server = createSimulatorServer({
    simulator,
    logger,
    send: (request) => {
      sent.push(request);
      return Promise.resolve();
    },
  });
  const started = server;
  await new Promise<void>((resolve) => {
    started.listen(0, resolve);
  });
  const address = started.address() as AddressInfo;
  return `http://127.0.0.1:${address.port.toString()}`;
}

describe("the simulator over HTTP", () => {
  it("serves a signed request and delivers the webhook it promised", async () => {
    const sent: SignedRequest[] = [];
    const base = await start(sent);
    const body = JSON.stringify({ amount: "10.00" });

    const response = await fetch(`${base}/keel/payouts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-id": "idem-1",
        "x-digital-signature": signKeel(body, KEEL_KEY, "idem-1"),
      },
      body,
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // This is the assertion C2 is about: a webhook actually left the
    // simulator. In the incumbent's development environment,
    // `keel_webhook_event` has never contained a row.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("http://receiver.invalid/keel/webhooks");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      reference: "KEEL-REF-1",
      state: "settled",
      eventType: "payout.status",
    });
    expect(sent[0]?.headers["x-digital-signature"]).toBe(
      signKeel(sent[0]?.body ?? "", KEEL_KEY),
    );
  });

  it("rejects an unsigned request and delivers nothing", async () => {
    const sent: SignedRequest[] = [];
    const base = await start(sent);
    const response = await fetch(`${base}/keel/payouts`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });

  it("exposes the request log", async () => {
    const base = await start([]);
    await fetch(`${base}/keel/payouts`, { method: "POST", body: "{}" });
    const log = (await (await fetch(`${base}/_sim/log`)).json()) as unknown[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 401, signatureValid: false });
  });

  it("switches scenario at runtime, and stops delivering under `never`", async () => {
    const sent: SignedRequest[] = [];
    const base = await start(sent);

    const applied = await fetch(`${base}/_sim/scenario`, {
      method: "POST",
      body: JSON.stringify({ mode: "never" }),
    });
    expect(applied.status).toBe(200);
    expect(await (await fetch(`${base}/_sim/scenario`)).json()).toMatchObject({
      mode: "never",
    });

    const body = JSON.stringify({ amount: "1.00" });
    await fetch(`${base}/keel/payouts`, {
      method: "POST",
      headers: {
        "x-idempotency-id": "i",
        "x-digital-signature": signKeel(body, KEEL_KEY, "i"),
      },
      body,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });

  it("refuses an unknown scenario rather than silently ignoring it", async () => {
    const base = await start([]);
    const response = await fetch(`${base}/_sim/scenario`, {
      method: "POST",
      body: JSON.stringify({ mode: "eventually" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Unknown delivery scenario") as unknown,
    });
  });

  it("rejects a malformed scenario body", async () => {
    const base = await start([]);
    expect(
      (await fetch(`${base}/_sim/scenario`, { method: "POST", body: "{" }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/_sim/scenario`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(400);
  });
});
