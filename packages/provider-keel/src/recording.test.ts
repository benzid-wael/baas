import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { TestClock, parseInstant } from "@baas/platform";
import type { ProviderCall, ProviderCallRecorder } from "@baas/domain";
import { KeelAccessTokens } from "./access-token.js";
import { jsonResponse, urlOf } from "./testing.js";
import { KeelHttp } from "./http.js";
import { KeelReads } from "./reads.js";
import { ACCOUNT_FIXTURE } from "./fixtures.js";
import type { KeelConfig } from "./config.js";

/**
 * Every call leaves a row (MP-2, finding C4).
 *
 * The incumbent's request log "was the only reason several failures were
 * explicable", and the failures worth explaining are the ones where something
 * went wrong — so the cases here are weighted towards those.
 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const START = parseInstant("2026-09-28T10:00:00.000Z");

const CONFIG: KeelConfig = {
  baseUrl: "https://sandbox.keel.example",
  clientId: "client",
  clientSecret: "secret",
  accessTokenEndpoint: "https://sandbox.keel.example/oauth/token",
  signingPrivateKeyPem: privateKey,
  httpTimeoutMs: 5_000,
};

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
  responder: (url: string) => { status: number; body: unknown } | Error,
): { reads: KeelReads; recorder: ReturnType<typeof collector> } {
  const clock = new TestClock(START);
  const recorder = collector();
  const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
    const url = urlOf(input);
    if (url.includes("/oauth/token")) {
      return Promise.resolve(
        jsonResponse({ access_token: "tok", expires_in: 3600 }, 200),
      );
    }
    const outcome = responder(url);
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    return Promise.resolve(jsonResponse(outcome.body, outcome.status));
  }) as typeof fetch;

  const http = new KeelHttp(
    CONFIG,
    new KeelAccessTokens(clock, fetchImpl),
    fetchImpl,
    clock,
    recorder,
  );
  return { reads: new KeelReads(http, clock), recorder };
}

describe("a Keel call is written down", () => {
  it("records a successful read as `ok`", async () => {
    const { reads, recorder } = readsWith(() => ({
      status: 200,
      body: { accounts: [ACCOUNT_FIXTURE] },
    }));
    await reads.listAccounts("owner-1");

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      providerId: "keel",
      outcome: "ok",
      responseStatus: 200,
    });
  });

  it("records the path and never the query string", async () => {
    // The query carries owner and account references, and this value is shown
    // in an operator console next to a list of other people's calls.
    const { reads, recorder } = readsWith(() => ({
      status: 200,
      body: { accounts: [] },
    }));
    await reads.listAccounts("owner-secret-1");

    expect(recorder.calls[0]?.operation).toBe("GET /api/baas/v2/accounts");
    expect(recorder.calls[0]?.operation).not.toContain("owner-secret-1");
  });

  it("records the route, not the reference, when the path carries one", async () => {
    // The detail read puts the account reference in the path. A list of fifty
    // of those in an operator console is fifty account references on screen,
    // and the column is useless for grouping besides.
    const { reads, recorder } = readsWith(() => ({
      status: 200,
      body: ACCOUNT_FIXTURE,
    }));
    await reads.getAccount("ACC-SECRET-1");

    expect(recorder.calls[0]?.operation).toBe(
      "GET /api/baas/v2/accounts/{accountReference}",
    );
    expect(recorder.calls[0]?.operation).not.toContain("ACC-SECRET-1");
  });

  it("records a refusal as `rejected`, with the body that explains it", async () => {
    const { reads, recorder } = readsWith(() => ({
      status: 422,
      body: { error: "owner not onboarded" },
    }));
    await expect(reads.listAccounts("owner-1")).rejects.toThrow();

    expect(recorder.calls[0]).toMatchObject({
      outcome: "rejected",
      responseStatus: 422,
    });
    expect(recorder.calls[0]?.responseBody).toContain("owner not onboarded");
  });

  it("records a call that never got an answer as `unreachable`", async () => {
    // Not `rejected`. We do not know whether Keel acted, and the log is where
    // somebody has to be able to see that distinction.
    const { reads, recorder } = readsWith(() => new Error("socket hang up"));
    await expect(reads.listAccounts("owner-1")).rejects.toThrow();

    expect(recorder.calls[0]).toMatchObject({ outcome: "unreachable" });
    expect(recorder.calls[0]?.responseStatus).toBeUndefined();
    expect(recorder.calls[0]?.errorMessage).toContain("socket hang up");
  });

  it("records nothing when no clock is supplied", async () => {
    // The seam that lets a fixture build an adapter without a database. It
    // must be an explicit absence, not a half-populated row.
    const clock = new TestClock(START);
    const recorder = collector();
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        jsonResponse(
          urlOf(input).includes("/oauth/token")
            ? { access_token: "tok", expires_in: 3600 }
            : { accounts: [] },
          200,
        ),
      )) as typeof fetch;

    const http = new KeelHttp(
      CONFIG,
      new KeelAccessTokens(clock, fetchImpl),
      fetchImpl,
    );
    await new KeelReads(http, clock).listAccounts("owner-1");
    expect(recorder.calls).toEqual([]);
  });
});
