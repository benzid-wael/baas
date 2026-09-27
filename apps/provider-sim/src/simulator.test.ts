import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Duration, Instant } from "@baas/domain";
import { SequenceIdGenerator, TestClock, parseInstant } from "@baas/platform";
import { Simulator } from "./simulator.js";
import type { SimulatorOptions } from "./simulator.js";
import { signKeel, signRuya } from "./signing.js";
import type { SimRoute } from "./routes.js";
import { DELIVERY_MODES } from "./scenario.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEEL_KEY = privateKey;
const RUYA_SECRET = "ruya-sandbox-secret";
const START = parseInstant("2026-09-26T12:00:00.000Z");

const PAYOUT: SimRoute = {
  provider: "keel",
  method: "POST",
  path: "/keel/payouts",
  signed: true,
  handle: () => ({
    status: 202,
    body: { reference: "KEEL-REF-1", status: "accepted" },
    accepted: {
      reference: "KEEL-REF-1",
      eventType: "payout.status",
      states: { accepted: "accepted", settled: "settled" },
    },
  }),
};

function build(overrides: Partial<SimulatorOptions> = {}): Simulator {
  return new Simulator({
    clock: new TestClock(START),
    ids: new SequenceIdGenerator(["ev-1", "ev-2", "ev-3"]),
    credentials: { keelPrivateKeyPem: KEEL_KEY, ruyaSecret: RUYA_SECRET },
    targets: { keel: "http://localhost:3000/keel/webhooks" },
    routes: [PAYOUT],
    ...overrides,
  });
}

function signedPost(
  simulator: Simulator,
  body: string,
  idempotencyId = "idem-1",
) {
  return simulator.handle(
    "POST",
    "/keel/payouts",
    {
      "x-digital-signature": signKeel(body, KEEL_KEY, idempotencyId),
      "x-idempotency-id": idempotencyId,
    },
    body,
  );
}

describe("routing and signatures", () => {
  let simulator: Simulator;
  beforeEach(() => {
    simulator = build();
  });

  it("404s an undeclared route rather than inventing a response", () => {
    const result = simulator.handle("GET", "/keel/nope", {}, "");
    expect(result.status).toBe(404);
  });

  it("serves a correctly signed request", () => {
    expect(signedPost(simulator, '{"amount":"10.00"}').status).toBe(202);
  });

  it("rejects an unsigned request", () => {
    const result = simulator.handle("POST", "/keel/payouts", {}, "{}");
    expect(result.status).toBe(401);
    expect(result.deliveries).toEqual([]);
  });

  it("rejects a body replayed under a different idempotency key", () => {
    // Keel signs `${body}${idempotencyId}`, so the signature is not portable
    // between operations. An adapter that reuses one is caught here rather
    // than by a partner sandbox returning 400.
    const body = '{"amount":"10.00"}';
    const result = simulator.handle(
      "POST",
      "/keel/payouts",
      {
        "x-digital-signature": signKeel(body, KEEL_KEY, "idem-1"),
        "x-idempotency-id": "idem-2",
      },
      body,
    );
    expect(result.status).toBe(401);
  });

  it("verifies Ruya with HMAC over the raw body", () => {
    const ruyaRoute: SimRoute = {
      ...PAYOUT,
      provider: "ruya",
      path: "/ruya/status",
    };
    const sim = build({ routes: [ruyaRoute], targets: {} });
    const body = '{"ref":"R1"}';
    expect(
      sim.handle(
        "POST",
        "/ruya/status",
        { "x-ruya-callback-signature": signRuya(body, RUYA_SECRET) },
        body,
      ).status,
    ).toBe(202);
    expect(
      sim.handle(
        "POST",
        "/ruya/status",
        { "x-ruya-callback-signature": "deadbeef" },
        body,
      ).status,
    ).toBe(401);
  });

  it("extracts path parameters", () => {
    const sim = build({
      routes: [
        {
          provider: "keel",
          method: "GET",
          path: "/keel/accounts/:id",
          signed: false,
          handle: (request) => ({
            status: 200,
            body: { id: request.params["id"] },
          }),
        },
      ],
    });
    expect(sim.handle("GET", "/keel/accounts/acc-7", {}, "").body).toEqual({
      id: "acc-7",
    });
  });
});

describe("delivery scenarios — the reason this exists (C2)", () => {
  const body = '{"amount":"10.00"}';

  it("prompt: one settled event, immediately", () => {
    const simulator = build();
    simulator.setScenario("prompt");
    const { deliveries } = signedPost(simulator, body);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.due.envelope.state).toBe("settled");
    expect(deliveries[0]?.due.dueAt.isSameAs(START)).toBe(true);
  });

  it("delayed: one settled event, after the caller has stopped waiting", () => {
    const simulator = build();
    simulator.setScenario("delayed", Duration.ofSeconds(30));
    const { deliveries } = signedPost(simulator, body);
    expect(deliveries[0]?.due.dueAt.since(START).milliseconds).toBe(30_000);
  });

  it("never: accepted, then silence — the A7 case", () => {
    // This is the incumbent's worst observed failure: Keel accepted an
    // account opening and completed it in under a second, and the absence of
    // a webhook froze every transfer and payout for that customer until two
    // operators adopted the account by hand.
    const simulator = build();
    simulator.setScenario("never");
    const result = signedPost(simulator, body);
    expect(result.status).toBe(202);
    expect(result.deliveries).toEqual([]);
  });

  it("duplicate: the same event twice, so ingestion must be idempotent", () => {
    const simulator = build();
    simulator.setScenario("duplicate", Duration.ofSeconds(5));
    const { deliveries } = signedPost(simulator, body);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.due.envelope.state)).toEqual([
      "settled",
      "settled",
    ]);
    expect(deliveries[0]?.due.envelope.reference).toBe(
      deliveries[1]?.due.envelope.reference,
    );
  });

  it("out_of_order: settled before accepted, so Outcome must be monotonic", () => {
    const simulator = build();
    simulator.setScenario("out_of_order", Duration.ofSeconds(5));
    const { deliveries } = signedPost(simulator, body);
    expect(deliveries.map((d) => d.due.envelope.state)).toEqual([
      "settled",
      "accepted",
    ]);
    expect(
      deliveries[1]?.due.dueAt.isAfter(deliveries[0]?.due.dueAt ?? START),
    ).toBe(true);
  });

  it("unsigned: delivered with a signature that must fail verification", () => {
    const simulator = build();
    simulator.setScenario("unsigned");
    const { deliveries } = signedPost(simulator, body);
    const sent = deliveries[0]?.request;
    expect(sent?.headers["x-digital-signature"]).toMatch(/XXXX$/);
    expect(sent?.headers["x-digital-signature"]).not.toBe(
      signKeel(sent?.body ?? "", KEEL_KEY),
    );
  });

  it("signs an honest delivery so the receiver can verify it", () => {
    const simulator = build();
    const { deliveries } = signedPost(simulator, body);
    const sent = deliveries[0]?.request;
    expect(sent?.headers["x-digital-signature"]).toBe(
      signKeel(sent?.body ?? "", KEEL_KEY),
    );
    expect(sent?.url).toBe("http://localhost:3000/keel/webhooks");
  });

  it("plans nothing when no target is configured", () => {
    const simulator = build({ targets: {} });
    expect(signedPost(simulator, body).deliveries).toEqual([]);
  });

  it("refuses an unknown scenario rather than defaulting to prompt", () => {
    expect(() => build().setScenario("eventually")).toThrow(
      /Unknown delivery scenario/,
    );
  });

  it("every declared mode is reachable", () => {
    for (const mode of DELIVERY_MODES) {
      expect(build().setScenario(mode).mode).toBe(mode);
    }
  });
});

describe("request log (C4)", () => {
  it("records inbound requests with their outcome and signature verdict", () => {
    const simulator = build();
    simulator.handle("POST", "/keel/payouts", {}, "{}");
    signedPost(simulator, '{"amount":"1.00"}');
    simulator.handle("GET", "/keel/nope", {}, "");

    const view = simulator.log.view();
    expect(view.map((entry) => entry.status)).toEqual([401, 202, 404]);
    expect(view[0]?.signatureValid).toBe(false);
    expect(view[1]?.signatureValid).toBe(true);
    expect(view[2]?.signatureValid).toBeNull();
    expect(view[0]?.at).toBe("2026-09-26T12:00:00.000Z");
  });

  it("keeps the log bounded", () => {
    const clock = new TestClock(Instant.EPOCH);
    const simulator = build({ clock });
    for (let index = 0; index < 60; index += 1) {
      simulator.handle("GET", "/keel/nope", {}, "");
    }
    expect(simulator.log.all().length).toBeLessThanOrEqual(500);
    simulator.log.clear();
    expect(simulator.log.all()).toEqual([]);
  });
});
