import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Duration, Instant } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { uuidv7 } from "uuidv7";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { Outbox, nextDelay, DEFAULT_RETRY } from "./outbox.js";
import { Inbox } from "./inbox.js";
import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyStore,
  fingerprint,
} from "./idempotency.js";

let harness: DatabaseHarness;
const TENANT = uuidv7();
const START = parseInstant("2026-09-26T12:00:00.000Z");

/** Ids must be unique across a whole file, so the generator is unbounded. */
function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 200 }, () => uuidv7()));
}

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "t", name: "T", created_at: toJsDate(START) })
    .execute();
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.db.deleteFrom("effect_outbox").execute();
  await harness.db.deleteFrom("provider_inbox").execute();
  await harness.db.deleteFrom("idempotency_record").execute();
});

function outbox(clock = new TestClock(START), random = () => 1): Outbox {
  return new Outbox(harness.db, clock, ids(), DEFAULT_RETRY, random);
}

function effect(operation = "payout.uk_domestic") {
  return {
    tenantId: TENANT,
    aggregateType: "payment_order",
    aggregateId: uuidv7(),
    providerId: "keel",
    operation,
    payload: { amount: "10.00", currency: "AED" },
  };
}

describe("the outbox is written with the change that justifies it", () => {
  it("rolls back the effect when the domain write fails", async () => {
    const box = outbox();
    await expect(
      harness.db.transaction().execute(async (trx) => {
        await box.enqueue(trx, effect());
        throw new Error("domain write failed");
      }),
    ).rejects.toThrow("domain write failed");

    const rows = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .execute();
    expect(rows).toEqual([]);
  });

  it("starts pending and immediately due", async () => {
    const box = outbox();
    await box.enqueue(harness.db, effect());
    const row = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toEqual(toJsDate(START));
  });
});

describe("claiming under a lease", () => {
  it("gives two workers disjoint sets", async () => {
    const box = outbox();
    for (let index = 0; index < 6; index += 1) {
      await box.enqueue(harness.db, effect());
    }

    const [first, second] = await Promise.all([
      box.claim("worker-a", 3),
      box.claim("worker-b", 3),
    ]);

    const claimed = [...first, ...second].map((entry) => entry.id);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed).size).toBe(6);
  });

  it("does not re-claim a leased row until the lease expires", async () => {
    const clock = new TestClock(START);
    const box = outbox(clock);
    await box.enqueue(harness.db, effect());

    expect(await box.claim("worker-a", 10, Duration.ofMinutes(5))).toHaveLength(
      1,
    );
    expect(await box.claim("worker-b", 10)).toEqual([]);

    // A worker that died mid-dispatch returns its row to the pool exactly once.
    clock.advanceBy(Duration.ofMinutes(6));
    const recovered = await box.claim("worker-b", 10);
    expect(recovered).toHaveLength(1);
  });

  it("does not claim an effect that is not yet due", async () => {
    const clock = new TestClock(START);
    const box = outbox(clock);
    const id = await box.enqueue(harness.db, effect());
    await box.recordFailure(id, "provider timeout", 0);

    expect(await box.claim("worker", 10)).toEqual([]);
    clock.advanceBy(Duration.ofMinutes(60));
    expect(await box.claim("worker", 10)).toHaveLength(1);
  });
});

describe("outcome transitions", () => {
  it("records a provider reference on dispatch", async () => {
    const box = outbox();
    const id = await box.enqueue(harness.db, effect());
    await box.claim("w", 1);
    await box.markDispatched(id, "KEEL-REF-1");

    const row = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("dispatched");
    expect(row.provider_ref).toBe("KEEL-REF-1");
    // The lease is released so a reconciler can pick the row up.
    expect(row.lease_until).toBeNull();
  });

  it("becomes unknown, not failed, once attempts are exhausted", async () => {
    // `failed` means the provider said no. `unknown` means we do not know, and
    // the reconciler owns it. Conflating them is how an unconfirmed 202 became
    // an operator's problem (finding A7).
    const box = outbox();
    const id = await box.enqueue(harness.db, effect());
    let state = "pending";
    for (let attempt = 0; attempt < DEFAULT_RETRY.maxAttempts; attempt += 1) {
      state = await box.recordFailure(id, "timeout", attempt);
    }
    expect(state).toBe("unknown");

    const row = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("unknown");
    expect(row.next_attempt_at).toBeNull();
  });

  it("distinguishes a provider rejection as terminal", async () => {
    const box = outbox();
    const id = await box.enqueue(harness.db, effect());
    await box.markRejected(id, "beneficiary account closed");
    const row = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("failed");
    expect(row.last_error).toContain("closed");
  });
});

describe("retry backoff", () => {
  it("grows exponentially and is capped", () => {
    const full = () => 1;
    expect(nextDelay(1, DEFAULT_RETRY, full).milliseconds).toBe(2_000);
    expect(nextDelay(2, DEFAULT_RETRY, full).milliseconds).toBe(4_000);
    expect(nextDelay(3, DEFAULT_RETRY, full).milliseconds).toBe(8_000);
    expect(nextDelay(30, DEFAULT_RETRY, full).milliseconds).toBe(
      DEFAULT_RETRY.maxDelay.milliseconds,
    );
  });

  it("jitters, so an outage does not synchronise every retry", () => {
    // Without jitter a provider outage lines every pending effect up on the
    // same instant, and the recovery attempt becomes the second outage.
    expect(nextDelay(5, DEFAULT_RETRY, () => 0).milliseconds).toBe(0);
    expect(nextDelay(5, DEFAULT_RETRY, () => 0.5).milliseconds).toBe(16_000);
  });
});

describe("the inbox records rather than processes", () => {
  function inbox(): Inbox {
    return new Inbox(harness.db, new TestClock(START), ids());
  }

  const event = (externalEventId: string | null, verified = true) => ({
    tenantId: TENANT,
    providerId: "keel",
    externalEventId,
    eventType: "payout.status",
    providerRef: "KEEL-REF-1",
    signatureVerified: verified,
    payload: { state: "settled" },
  });

  it("stores a delivery verbatim", async () => {
    const box = inbox();
    const recorded = await box.record(event("ev-1"));
    expect(recorded.isNew).toBe(true);

    const row = await harness.db
      .selectFrom("provider_inbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual({ state: "settled" });
    expect(row.processed_at).toBeNull();
  });

  it("is exactly-once when the provider supplies an event id", async () => {
    const box = inbox();
    const first = await box.record(event("ev-dup"));
    const second = await box.record(event("ev-dup"));
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(
      await harness.db.selectFrom("provider_inbox").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("keeps a rejected signature instead of dropping it", async () => {
    // Dropping it erases the only evidence that someone is probing the
    // endpoint, and makes a misconfigured partner look like a silent one.
    const box = inbox();
    await box.record(event("ev-bad", false));
    const rows = await harness.db
      .selectFrom("provider_inbox")
      .selectAll()
      .execute();
    expect(rows[0]?.signature_verified).toBe(false);
    // ...but it is not offered to the reconciler.
    expect(await box.pending(10)).toEqual([]);
  });

  it("offers unprocessed verified deliveries oldest first", async () => {
    const box = inbox();
    await box.record(event("ev-a"));
    await box.record(event("ev-b"));
    const pending = await box.pending(10);
    expect(pending).toHaveLength(2);

    await box.markProcessed(pending[0]?.id ?? "");
    expect(await box.pending(10)).toHaveLength(1);
  });
});

describe("idempotency", () => {
  function store(): IdempotencyStore {
    return new IdempotencyStore(harness.db, new TestClock(START), ids());
  }

  const options = (request: unknown) => ({
    tenantId: TENANT,
    scope: "payment-order.create",
    key: "idem-1",
    request,
  });

  it("runs once and replays the stored result", async () => {
    const first = store();
    let runs = 0;
    const operation = async () => {
      runs += 1;
      return Promise.resolve({ orderId: "order-1" });
    };

    expect(
      await first.execute(options({ amount: "10.00" }), operation),
    ).toEqual({
      orderId: "order-1",
    });
    expect(
      await first.execute(options({ amount: "10.00" }), operation),
    ).toEqual({
      orderId: "order-1",
    });
    expect(runs).toBe(1);
  });

  it("refuses a reused key carrying a different request", async () => {
    // Replaying a stored result for a different request would answer a payment
    // of one amount with the outcome of another.
    const first = store();
    await first.execute(options({ amount: "10.00" }), () =>
      Promise.resolve({ ok: true }),
    );
    await expect(
      first.execute(options({ amount: "999.00" }), () =>
        Promise.resolve({ ok: true }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("treats a reordered body as the same request", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("reports an in-flight key rather than blocking on it", async () => {
    // A blocking wait would hold an HTTP request open behind a provider call
    // that may take minutes or never finish.
    const first = store();
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 60));
    const slow = first.execute(options({ amount: "1.00" }), async () => {
      await gate;
      return { ok: true };
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      store().execute(options({ amount: "1.00" }), () =>
        Promise.resolve({ ok: true }),
      ),
    ).rejects.toThrow(IdempotencyInFlightError);
    await slow;
  });

  it("lets two concurrent callers produce one effect", async () => {
    const attempts: number[] = [];
    const run = () =>
      store().execute(options({ amount: "5.00" }), () => {
        attempts.push(1);
        return Promise.resolve({ ok: true });
      });

    const results = await Promise.allSettled([run(), run(), run()]);
    expect(attempts).toHaveLength(1);
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThan(0);
  });
});

describe("instants survive the database", () => {
  it("round-trips through timestamptz without drift", async () => {
    const box = outbox();
    await box.enqueue(harness.db, effect());
    const row = await harness.db
      .selectFrom("effect_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(
      Instant.fromEpochMilliseconds(row.created_at.getTime()).isSameAs(START),
    ).toBe(true);
  });
});
