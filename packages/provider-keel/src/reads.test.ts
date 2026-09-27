import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { Instant } from "@baas/domain";
import { TestClock, formatInstant, parseInstant } from "@baas/platform";
import { KeelAccessTokens } from "./access-token.js";
import { jsonResponse, urlOf } from "./testing.js";
import { KeelHttp } from "./http.js";
import { KeelReads } from "./reads.js";
import { KeelApiError, KeelTransportError } from "./errors.js";
import { keelOauthScope } from "./config.js";
import type { KeelConfig } from "./config.js";
import { signKeelRequest } from "./signing.js";
import { ACCOUNT_FIXTURE, TRANSACTIONS_FIXTURE } from "./fixtures.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const START = parseInstant("2026-09-27T12:00:00.000Z");

const CONFIG: KeelConfig = {
  baseUrl: "https://sandbox.keel.example",
  clientId: "client",
  clientSecret: "secret",
  accessTokenEndpoint: "https://sandbox.keel.example/oauth/token",
  signingPrivateKeyPem: privateKey,
  httpTimeoutMs: 5_000,
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(
  responder: (captured: Captured) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const captured: Captured = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(captured);
    const { status, body } = responder(captured);
    return Promise.resolve(jsonResponse(body, status));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function readsWith(
  responder: (captured: Captured) => { status: number; body: unknown },
  clock = new TestClock(START),
) {
  const { fetchImpl, calls } = stub(responder);
  const tokens = new KeelAccessTokens(clock, fetchImpl);
  return {
    reads: new KeelReads(new KeelHttp(CONFIG, tokens, fetchImpl), clock),
    calls,
  };
}

const TOKEN_OK = { access_token: "tok-1", expires_in: 3600 };

function respond(captured: Captured): { status: number; body: unknown } {
  if (captured.url.includes("/oauth/token"))
    return { status: 200, body: TOKEN_OK };
  if (captured.url.includes("/transactions")) {
    return { status: 200, body: TRANSACTIONS_FIXTURE };
  }
  if (/\/accounts\/[^?]+$/.test(captured.url)) {
    return { status: 200, body: ACCOUNT_FIXTURE };
  }
  return { status: 200, body: { accounts: [ACCOUNT_FIXTURE] } };
}

describe("the request we build matches Keel's contract", () => {
  it("authenticates with a bearer token and the derived OAuth scope", async () => {
    const { reads, calls } = readsWith(respond);
    await reads.listAccounts("owner-1");

    const token = calls.find((call) => call.url.includes("/oauth/token"));
    expect(token?.body).toContain("grant_type=client_credentials");
    // URLSearchParams encodes the spaces in the scope as `+`, so the body is
    // parsed rather than string-matched.
    expect(new URLSearchParams(token?.body ?? "").get("scope")).toBe(
      keelOauthScope(CONFIG.baseUrl),
    );

    const read = calls.find((call) => call.url.includes("/accounts"));
    expect(read?.headers["Authorization"]).toBe("Bearer tok-1");
    expect(read?.headers["Accept"]).toBe("application/json");
  });

  it("never signs a GET, and sends no idempotency id on one", async () => {
    // Keel rejects a signed GET with a 400 that says nothing about
    // signatures. This asymmetry is the most useful thing carried over.
    const { reads, calls } = readsWith(respond);
    await reads.getAccount("acc-1");
    const read = calls.find((call) => call.url.includes("/accounts/"));
    expect(read?.headers["X-Digital-Signature"]).toBeUndefined();
    expect(read?.headers["X-Idempotency-Id"]).toBeUndefined();
  });

  it("signs a non-GET over body and idempotency id together", async () => {
    // Signing the body alone would let a replayed body carry a valid
    // signature under a different idempotency key.
    const { fetchImpl } = stub(respond);
    const http = new KeelHttp(
      CONFIG,
      new KeelAccessTokens(new TestClock(START), fetchImpl),
      fetchImpl,
    );
    const body = JSON.stringify({ amount: "10.00" });
    const headers = await http.headersFor("POST", body, {
      idempotencyId: "idem-1",
    });

    const verified = createVerify("RSA-SHA256")
      .update(`${body}idem-1`)
      .verify(publicKey, headers["X-Digital-Signature"] ?? "", "base64");
    expect(verified).toBe(true);
    expect(headers["X-Digital-Signature"]).toBe(
      signKeelRequest(body, "idem-1", privateKey),
    );
  });

  it("passes the account reference and paging as query parameters", async () => {
    const { reads, calls } = readsWith(respond);
    await reads.listTransactions({
      accountReference: "acc-1",
      cursor: "cur-2",
      limit: 50,
    });
    const url =
      calls.find((call) => call.url.includes("/transactions"))?.url ?? "";
    expect(url).toContain("accountId=acc-1");
    expect(url).toContain("cursor=cur-2");
    expect(url).toContain("limit=50");
  });
});

describe("a recorded response maps to the domain type", () => {
  it("maps an account", async () => {
    const { reads } = readsWith(respond);
    const account = await reads.getAccount("acc-1");
    expect(account).toMatchObject({
      accountReference: "acc-1",
      product: "current_account",
      currency: "AED",
      status: "active",
      iban: "AE070331234567890123456",
    });
    expect(account?.openedAt && formatInstant(account.openedAt)).toBe(
      "2026-01-15T09:30:00.000Z",
    );
  });

  it("maps a balance as Money, with the time it was observed", async () => {
    const { reads } = readsWith(respond);
    const balance = await reads.getBalance("acc-1");
    expect(balance?.available.toDecimalString()).toBe("1234.50");
    expect(balance?.current.toDecimalString()).toBe("1300.00");
    expect(balance?.available.currency).toBe("AED");
    expect(balance?.observedAt).toBeInstanceOf(Instant);
  });

  it("decides direction from which side the account is on", async () => {
    const { reads } = readsWith(respond);
    const page = await reads.listTransactions({
      accountReference: "acc-1",
      limit: 20,
    });
    expect(
      page.transactions.map((t) => [t.transactionReference, t.direction]),
    ).toEqual([
      ["txn-1", "debit"],
      ["txn-2", "credit"],
    ]);
    expect(page.transactions[0]?.counterpartyName).toBe("Acme Supplies");
    expect(page.transactions[1]?.counterpartyName).toBe("Payroll Ltd");
    expect(page.nextCursor).toBe("cur-3");
  });

  it("maps an unrecognised status to unknown, never to a plausible default", async () => {
    // A status we do not recognise becoming `active` is how a closed account
    // gets shown as usable.
    const { reads } = readsWith((captured) =>
      captured.url.includes("/oauth/token")
        ? { status: 200, body: TOKEN_OK }
        : { status: 200, body: { ...ACCOUNT_FIXTURE, status: "ESCHEATED" } },
    );
    expect((await reads.getAccount("acc-1"))?.status).toBe("unknown");
  });

  it("tolerates an account with no IBAN, which the sandbox produces", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.includes("/oauth/token")
        ? { status: 200, body: TOKEN_OK }
        : {
            status: 200,
            body: { ...ACCOUNT_FIXTURE, iban: null, sortCode: null },
          },
    );
    expect((await reads.getAccount("acc-1"))?.iban).toBeNull();
  });

  it("returns no balance rather than a zero when the provider omits one", async () => {
    // Rendering an absent balance as zero next to a confident total is
    // finding F4, and it reads as "you have no money".
    const { reads } = readsWith((captured) =>
      captured.url.includes("/oauth/token")
        ? { status: 200, body: TOKEN_OK }
        : { status: 200, body: { ...ACCOUNT_FIXTURE, availableBalance: null } },
    );
    expect(await reads.getBalance("acc-1")).toBeUndefined();
  });
});

describe("errors keep the distinction that matters", () => {
  it("treats a 404 as an answer", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.includes("/oauth/token")
        ? { status: 200, body: TOKEN_OK }
        : { status: 404, body: { message: "not found" } },
    );
    expect(await reads.getAccount("nope")).toBeUndefined();
  });

  it("does not turn a 500 into absence", async () => {
    // Reporting "no such account" for an outage is how a caller caches an
    // outage as a fact.
    const { reads } = readsWith((captured) =>
      captured.url.includes("/oauth/token")
        ? { status: 200, body: TOKEN_OK }
        : { status: 500, body: { message: "boom" } },
    );
    await expect(reads.getAccount("acc-1")).rejects.toThrow(KeelApiError);
  });

  it("separates a transport failure from a refusal", async () => {
    // One is terminal, the other is unknown and belongs to the reconciler.
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) =>
      urlOf(input).includes("/oauth/token")
        ? Promise.resolve(jsonResponse(TOKEN_OK))
        : Promise.reject(new Error("socket hang up"))) as typeof fetch;

    const clock = new TestClock(START);
    const reads = new KeelReads(
      new KeelHttp(CONFIG, new KeelAccessTokens(clock, fetchImpl), fetchImpl),
      clock,
    );
    await expect(reads.getAccount("acc-1")).rejects.toThrow(KeelTransportError);
  });
});
