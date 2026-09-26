import { describe, expect, it, vi } from "vitest";
import { Duration, Instant } from "@baas/domain";
import { TestClock, createLogger } from "@baas/platform";
import { Dispatcher, type ProviderDispatch } from "./dispatcher.js";
import { Reconciler, isForwardTransition } from "./reconciler.js";
import { Scheduler } from "./scheduler.js";
import type { Job } from "./scheduler.js";

const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});
const START = Instant.fromEpochMilliseconds(1_700_000_000_000);

function fakeOutbox() {
  return {
    claim: vi.fn(),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    markConfirmed: vi.fn().mockResolvedValue(undefined),
    markRejected: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue("pending"),
  };
}

const EFFECT = {
  id: "eff-1",
  tenantId: "t-1",
  providerId: "keel",
  operation: "payout.uk_domestic",
  payload: {},
  attempts: 0,
};

function dispatcher(
  outbox: ReturnType<typeof fakeOutbox>,
  provider: ProviderDispatch | undefined,
) {
  return new Dispatcher({
    outbox: outbox as never,
    providers:
      provider === undefined ? new Map() : new Map([["keel", provider]]),
    logger,
    workerId: "worker-1",
  });
}

describe("dispatcher", () => {
  it("marks an accepted effect dispatched with its reference", async () => {
    const outbox = fakeOutbox();
    outbox.claim.mockResolvedValue([EFFECT]);
    const run = await dispatcher(outbox, {
      send: () => Promise.resolve({ kind: "accepted", providerRef: "REF-1" }),
    }).runOnce();

    expect(outbox.markDispatched).toHaveBeenCalledWith("eff-1", "REF-1");
    expect(run).toMatchObject({ claimed: 1, accepted: 1 });
  });

  it("confirms an effect the provider settled synchronously", async () => {
    const outbox = fakeOutbox();
    outbox.claim.mockResolvedValue([EFFECT]);
    await dispatcher(outbox, {
      send: () => Promise.resolve({ kind: "settled", providerRef: "REF-2" }),
    }).runOnce();
    expect(outbox.markConfirmed).toHaveBeenCalledWith("eff-1", "REF-2");
  });

  it("treats a rejection as terminal, not as a retry", async () => {
    const outbox = fakeOutbox();
    outbox.claim.mockResolvedValue([EFFECT]);
    const run = await dispatcher(outbox, {
      send: () =>
        Promise.resolve({ kind: "rejected", reason: "account closed" }),
    }).runOnce();
    expect(outbox.markRejected).toHaveBeenCalledWith("eff-1", "account closed");
    expect(run.rejected).toBe(1);
    expect(outbox.recordFailure).not.toHaveBeenCalled();
  });

  it("treats a throw as unknown, never as failure", async () => {
    // A throw means we do not know whether the provider acted. Recording it as
    // a rejection would assert something untrue about someone's money.
    const outbox = fakeOutbox();
    outbox.claim.mockResolvedValue([EFFECT]);
    outbox.recordFailure.mockResolvedValue("unknown");
    const run = await dispatcher(outbox, {
      send: () => Promise.reject(new Error("socket hang up")),
    }).runOnce();

    expect(outbox.markRejected).not.toHaveBeenCalled();
    expect(outbox.recordFailure).toHaveBeenCalledWith(
      "eff-1",
      "socket hang up",
      0,
    );
    expect(run.unknown).toBe(1);
  });

  it("rejects an effect whose adapter is missing rather than retrying forever", async () => {
    const outbox = fakeOutbox();
    outbox.claim.mockResolvedValue([EFFECT]);
    const run = await dispatcher(outbox, undefined).runOnce();
    expect(outbox.markRejected).toHaveBeenCalledWith(
      "eff-1",
      'no adapter registered for provider "keel"',
    );
    expect(run.rejected).toBe(1);
  });
});

describe("outcome transitions are monotonic", () => {
  it("moves forward", () => {
    expect(isForwardTransition("pending", "accepted")).toBe(true);
    expect(isForwardTransition("dispatched", "settled")).toBe(true);
    expect(isForwardTransition("unknown", "settled")).toBe(true);
  });

  it("never lets a late accepted overwrite a settled", () => {
    // Providers deliver out of order. This is the property the simulator's
    // `out_of_order` scenario exists to exercise.
    expect(isForwardTransition("settled", "accepted")).toBe(false);
    expect(isForwardTransition("confirmed", "dispatched")).toBe(false);
    expect(isForwardTransition("failed", "accepted")).toBe(false);
  });

  it("treats a repeat of the same state as not forward, so it is idempotent", () => {
    expect(isForwardTransition("settled", "settled")).toBe(false);
    expect(isForwardTransition("dispatched", "accepted")).toBe(false);
  });
});

describe("reconciler", () => {
  function fakeInbox(rows: { id: string; payload: unknown }[]) {
    return {
      pending: vi.fn().mockResolvedValue(rows),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
  }

  const interpret = (payload: unknown) =>
    payload as { providerRef: string | null; state: string };

  it("applies a settled outcome and marks the event processed", async () => {
    const inbox = fakeInbox([
      { id: "in-1", payload: { providerRef: "REF-1", state: "settled" } },
    ]);
    const outbox = fakeOutbox();
    const run = await new Reconciler({
      inbox: inbox as never,
      outbox: outbox as never,
      logger,
      interpret,
      lookup: () => Promise.resolve({ id: "eff-1", state: "dispatched" }),
    }).runOnce();

    expect(outbox.markConfirmed).toHaveBeenCalledWith("eff-1", "REF-1");
    expect(inbox.markProcessed).toHaveBeenCalledWith("in-1");
    expect(run).toMatchObject({ applied: 1, ignored: 0 });
  });

  it("ignores a non-forward outcome without losing the event", async () => {
    const inbox = fakeInbox([
      { id: "in-2", payload: { providerRef: "REF-1", state: "accepted" } },
    ]);
    const outbox = fakeOutbox();
    const run = await new Reconciler({
      inbox: inbox as never,
      outbox: outbox as never,
      logger,
      interpret,
      lookup: () => Promise.resolve({ id: "eff-1", state: "confirmed" }),
    }).runOnce();

    expect(outbox.markDispatched).not.toHaveBeenCalled();
    expect(inbox.markProcessed).toHaveBeenCalledWith("in-2");
    expect(run.ignored).toBe(1);
  });

  it("leaves an event unprocessed when its effect is not yet known", async () => {
    // A webhook can legitimately arrive before the dispatcher has recorded its
    // reference. Consuming it here would lose the only evidence of settlement.
    const inbox = fakeInbox([
      { id: "in-3", payload: { providerRef: "REF-X", state: "settled" } },
    ]);
    const run = await new Reconciler({
      inbox: inbox as never,
      outbox: fakeOutbox() as never,
      logger,
      interpret,
      lookup: () => Promise.resolve(undefined),
    }).runOnce();

    expect(inbox.markProcessed).not.toHaveBeenCalled();
    expect(run.unmatched).toBe(1);
  });

  it("records an event with no reference rather than retrying it forever", async () => {
    const inbox = fakeInbox([
      { id: "in-4", payload: { providerRef: null, state: "x" } },
    ]);
    await new Reconciler({
      inbox: inbox as never,
      outbox: fakeOutbox() as never,
      logger,
      interpret,
      lookup: () => Promise.resolve(undefined),
    }).runOnce();
    expect(inbox.markProcessed).toHaveBeenCalledWith(
      "in-4",
      "event carries no provider reference",
    );
  });
});

describe("scheduler", () => {
  function job(
    name: string,
    every: Duration,
    run = () => Promise.resolve(),
  ): Job {
    return { name, every, run };
  }

  it("runs a job when due and not before", async () => {
    const clock = new TestClock(START);
    const ran: string[] = [];
    const scheduler = new Scheduler({
      clock,
      logger,
      jobs: [
        job("reconcile", Duration.ofSeconds(30), () => {
          ran.push("reconcile");
          return Promise.resolve();
        }),
      ],
    });

    expect(await scheduler.tick()).toEqual(["reconcile"]);
    expect(await scheduler.tick()).toEqual([]);

    clock.advanceBy(Duration.ofSeconds(31));
    expect(await scheduler.tick()).toEqual(["reconcile"]);
    expect(ran).toHaveLength(2);
  });

  it("keeps running other jobs when one throws", async () => {
    const clock = new TestClock(START);
    const scheduler = new Scheduler({
      clock,
      logger,
      jobs: [
        job("broken", Duration.ofSeconds(1), () =>
          Promise.reject(new Error("nope")),
        ),
        job("healthy", Duration.ofSeconds(1)),
      ],
    });
    expect(await scheduler.tick()).toEqual(["healthy"]);
  });

  it("reschedules from completion, so a slow job cannot lap itself", async () => {
    const clock = new TestClock(START);
    const scheduler = new Scheduler({
      clock,
      logger,
      jobs: [
        job("slow", Duration.ofSeconds(10), () => {
          clock.advanceBy(Duration.ofSeconds(25));
          return Promise.resolve();
        }),
      ],
    });

    await scheduler.tick();
    // Due 10s after it finished, not 10s after it started.
    expect(scheduler.nextDueAt()?.since(START).milliseconds).toBe(35_000);
    expect(await scheduler.tick()).toEqual([]);
  });
});
