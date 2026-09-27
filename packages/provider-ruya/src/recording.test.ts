import { describe, expect, it } from "vitest";
import { TestClock, parseInstant } from "@baas/platform";
import type { ProviderCall, ProviderCallRecorder } from "@baas/domain";
import { RuyaHttp } from "./http.js";
import { RuyaReads } from "./reads.js";
import type { RuyaConfig } from "./config.js";

/**
 * Every Ruya attempt leaves a row (MP-2).
 *
 * Ruya retries, and that is the interesting part: a request that succeeded on
 * its third try after two 500s is a different thing from one that succeeded
 * immediately, and only the person reading the log can decide whether it
 * matters. So the unit of a row is an **attempt**, not a call.
 */
const START = parseInstant("2026-09-28T11:00:00.000Z");

const CONFIG: RuyaConfig = {
  baseUrl: "https://bancs.ruya.example",
  clientId: "client",
  clientSecret: "secret",
  entity: "RUYA",
  languageCode: 1,
  userId: 42,
  channelId: 7,
  httpTimeoutMs: 5_000,
  tokenRefreshBufferSeconds: 60,
  maxRetries: 2,
};

const TOKEN = JSON.stringify({ access_token: "tok-1", expires_in: 3600 });
const BALANCE = JSON.stringify({
  accountBalanceDetails: {
    balance: {
      accountReference: "ACC-1",
      amount: { accountBalance: "10.00", balanceAmountCurrency: "AED" },
      creditDebitIndicator: "C",
      dateTime: "2026-09-28T10:59:00.000Z",
    },
  },
});

function collector(): ProviderCallRecorder & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  return {
    calls,
    record: (call) => {
      calls.push(call);
      return Promise.resolve();
    },
  };
}

function readsWith(
  responder: (url: string, attempt: number) => { status: number; body: string },
): { reads: RuyaReads; recorder: ReturnType<typeof collector> } {
  const clock = new TestClock(START);
  const recorder = collector();
  let attempts = 0;
  const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/token")) {
      return Promise.resolve(
        new Response(TOKEN, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    attempts += 1;
    const { status, body } = responder(url, attempts);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const http = new RuyaHttp(CONFIG, clock, fetchImpl, recorder);
  return { reads: new RuyaReads(http, clock), recorder };
}

describe("a Ruya call is written down", () => {
  it("records a successful read as `ok`", async () => {
    const { reads, recorder } = readsWith(() => ({
      status: 200,
      body: BALANCE,
    }));
    await reads.getAccount("ACC-1");

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      providerId: "ruya",
      outcome: "ok",
      responseStatus: 200,
    });
  });

  it("records one row per attempt when the provider retries", async () => {
    const { reads, recorder } = readsWith((_url, attempt) =>
      attempt < 3
        ? { status: 503, body: '{"error":"unavailable"}' }
        : { status: 200, body: BALANCE },
    );
    await reads.getAccount("ACC-1");

    expect(recorder.calls.map((call) => call.outcome)).toEqual([
      "rejected",
      "rejected",
      "ok",
    ]);
    expect(recorder.calls.map((call) => call.responseStatus)).toEqual([
      503, 503, 200,
    ]);
  });

  it("records the route, not the reference, when the path carries one", async () => {
    // BaNCS puts the account reference in the path, which is how this was
    // found: the first version of this test failed, and it was right to.
    const { reads, recorder } = readsWith(() => ({
      status: 200,
      body: BALANCE,
    }));
    await reads.getAccount("ACC-SECRET-1");

    expect(recorder.calls[0]?.operation).toBe(
      "GET /ruya/gbprest/accountManagement/account/balanceDetails/{accountReference}",
    );
    expect(recorder.calls[0]?.operation).not.toContain("ACC-SECRET-1");
  });

  it("records a refusal the retries did not fix", async () => {
    const { reads, recorder } = readsWith(() => ({
      status: 404,
      body: '{"error":"no such account"}',
    }));
    await expect(reads.getAccount("ACC-1")).resolves.toBeUndefined();
    expect(recorder.calls.at(-1)).toMatchObject({
      outcome: "rejected",
      responseStatus: 404,
    });
  });
});
