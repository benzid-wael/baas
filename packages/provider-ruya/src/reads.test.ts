import { describe, expect, it } from "vitest";
import { Duration } from "@baas/domain";
import { TestClock, formatInstant, parseInstant } from "@baas/platform";
import { RuyaHttp, parseRuyaJson } from "./http.js";
import { RuyaReads } from "./reads.js";
import {
  RuyaApiError,
  RuyaNotConfiguredError,
  RuyaTransportError,
} from "./errors.js";
import type { RuyaConfig } from "./config.js";

const START = parseInstant("2026-09-27T13:00:00.000Z");
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

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function server(
  responder: (
    captured: Captured,
    call: number,
  ) => { status: number; body: string },
) {
  const calls: Captured[] = [];
  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const captured: Captured = {
      url: urlOf(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(captured);
    const { status, body } = responder(captured, calls.length);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN = JSON.stringify({ access_token: "tok-1", expires_in: 3600 });

const BALANCE = JSON.stringify({
  accountBalanceDetails: {
    balance: {
      accountReference: "ACC-1",
      amount: { accountBalance: "1234.50", balanceAmountCurrency: "AED" },
      creditDebitIndicator: "C",
      dateTime: "2026-09-27T12:59:00.000Z",
    },
  },
});

/**
 * A number JSON.parse genuinely corrupts: 1234567890123456.78 comes back as
 * 1234567890123456.8, losing a fil. Written as raw text rather than built
 * from an object, because building it would round-trip it first.
 */
const LOSSY_AMOUNT = "1234567890123456.78";
const BIG_BALANCE = `{"accountBalanceDetails":{"balance":{"accountReference":"ACC-1","amount":{"accountBalance":${LOSSY_AMOUNT},"balanceAmountCurrency":"AED"},"dateTime":"2026-09-27T12:59:00.000Z"}}}`;

const ACCOUNTS = JSON.stringify({
  hasNext: "N",
  accountBalanceList: [
    {
      accountReference: "ACC-1",
      accountStatus: "ACTIVE",
      currency: "AED",
      iban: "AE070331234567890123456",
      accountNumber: "0331234567",
      openDate: "2026-02-01T00:00:00.000Z",
    },
  ],
});

const TRANSACTIONS = JSON.stringify({
  hasNext: "Y",
  transactionDetails: [
    {
      transactionReference: "TXN-1",
      amount: { transactionAmount: "250.00", currency: "AED" },
      creditDebitIndicator: "D",
      transactionStatus: "BOOKED",
      counterPartyName: "Acme Supplies",
      narrative: "Invoice 4471",
      bookingDateTime: "2026-09-20T08:00:00.000Z",
    },
  ],
});

function route(captured: Captured): { status: number; body: string } {
  if (captured.url.endsWith("/token")) return { status: 200, body: TOKEN };
  if (captured.url.includes("balanceDetails"))
    return { status: 200, body: BALANCE };
  if (captured.url.includes("balanceList"))
    return { status: 200, body: ACCOUNTS };
  return { status: 200, body: TRANSACTIONS };
}

function readsWith(
  responder: (
    captured: Captured,
    call: number,
  ) => { status: number; body: string } = route,
  clock = new TestClock(START),
) {
  const { fetchImpl, calls } = server(responder);
  return {
    reads: new RuyaReads(new RuyaHttp(CONFIG, clock, fetchImpl), clock),
    calls,
    clock,
  };
}

describe("money survives the wire", () => {
  it("parses numbers losslessly, because a double would corrupt an amount", () => {
    // This is the whole reason the transport does not use JSON.parse. TCS
    // BaNCS returns amounts as JSON numbers, and a double loses digits
    // silently and plausibly.
    const text = `{"a":${LOSSY_AMOUNT}}`;
    expect(String((parseRuyaJson(text) as { a: unknown }).a)).toBe(
      LOSSY_AMOUNT,
    );

    // The same text through JSON.parse loses the last digit -- silently, and
    // to a value that still looks like money.
    expect(String((JSON.parse(text) as { a: number }).a)).toBe(
      "1234567890123456.8",
    );
  });

  it("carries a large balance through to Money without losing a digit", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.endsWith("/token")
        ? { status: 200, body: TOKEN }
        : { status: 200, body: BIG_BALANCE },
    );
    const balance = await reads.getBalance("ACC-1");
    expect(balance?.available.toDecimalString()).toBe(LOSSY_AMOUNT);
  });
});

describe("the request we build matches Ruya's contract", () => {
  it("sends the four headers BaNCS demands on every call", async () => {
    // Omitting one produces an error that names none of them.
    const { reads, calls } = readsWith();
    await reads.getBalance("ACC-1");
    const read = calls.find((call) => call.url.includes("balanceDetails"));
    expect(read?.headers).toMatchObject({
      entity: "RUYA",
      languageCode: "1",
      userId: "42",
      channelId: "7",
      Authorization: "Bearer tok-1",
    });
  });

  it("pages accounts and transactions by page number", async () => {
    const { reads, calls } = readsWith();
    await reads.listAccounts("CUST-1");
    expect(calls.at(-1)?.url).toContain("CustomerID=CUST-1");

    await reads.listTransactions({
      accountReference: "ACC-1",
      cursor: "3",
      limit: 20,
    });
    expect(calls.at(-1)?.url).toContain("pageNum=3");
  });
});

describe("token handling", () => {
  it("reuses a token and refreshes before the buffer, not at expiry", async () => {
    const clock = new TestClock(START);
    const { reads, calls } = readsWith(route, clock);
    await reads.getBalance("ACC-1");
    await reads.getBalance("ACC-1");
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);

    clock.advanceBy(Duration.ofSeconds(3600 - 59));
    await reads.getBalance("ACC-1");
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
  });

  it("retries a 401 exactly once, with a fresh token", async () => {
    // Retrying repeatedly would turn a revoked credential into a hot loop
    // against the token endpoint.
    let unauthorised = 0;
    const { reads, calls } = readsWith((captured) => {
      if (captured.url.endsWith("/token")) return { status: 200, body: TOKEN };
      unauthorised += 1;
      return unauthorised === 1
        ? { status: 401, body: "{}" }
        : { status: 200, body: BALANCE };
    });

    expect(await reads.getBalance("ACC-1")).toBeDefined();
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
  });

  it("gives up on a persistent 401 rather than looping", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.endsWith("/token")
        ? { status: 200, body: TOKEN }
        : { status: 401, body: "{}" },
    );
    await expect(reads.getBalance("ACC-1")).rejects.toThrow(RuyaApiError);
  });

  it("says so when it is not configured", async () => {
    const { fetchImpl } = server(route);
    const http = new RuyaHttp(
      { ...CONFIG, clientSecret: "" },
      new TestClock(START),
      fetchImpl,
    );
    await expect(http.accessToken()).rejects.toThrow(RuyaNotConfiguredError);
  });
});

describe("a recorded response maps to the domain type", () => {
  it("maps a balance with the time the bank observed it", async () => {
    const { reads } = readsWith();
    const balance = await reads.getBalance("ACC-1");
    expect(balance?.available.toDecimalString()).toBe("1234.50");
    expect(balance?.available.currency).toBe("AED");
    expect(balance && formatInstant(balance.observedAt)).toBe(
      "2026-09-27T12:59:00.000Z",
    );
  });

  it("maps an account list", async () => {
    const { reads } = readsWith();
    const [account] = await reads.listAccounts("CUST-1");
    expect(account).toMatchObject({
      accountReference: "ACC-1",
      status: "active",
      currency: "AED",
      iban: "AE070331234567890123456",
    });
  });

  it("reads direction from the credit-debit indicator, not from party names", async () => {
    const { reads } = readsWith();
    const page = await reads.listTransactions({
      accountReference: "ACC-1",
      limit: 20,
    });
    expect(page.transactions[0]).toMatchObject({
      transactionReference: "TXN-1",
      direction: "debit",
      status: "settled",
      counterpartyName: "Acme Supplies",
    });
    expect(page.transactions[0]?.amount.toDecimalString()).toBe("250.00");
    expect(page.nextCursor).toBe("2");
  });

  it("maps an unrecognised status to unknown", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.endsWith("/token")
        ? { status: 200, body: TOKEN }
        : {
            status: 200,
            body: JSON.stringify({
              hasNext: "N",
              accountBalanceList: [
                {
                  accountReference: "ACC-1",
                  accountStatus: "ESCHEATED",
                  currency: "AED",
                },
              ],
            }),
          },
    );
    expect((await reads.listAccounts("CUST-1"))[0]?.status).toBe("unknown");
  });
});

describe("errors keep the distinction that matters", () => {
  it("treats a 404 as an answer", async () => {
    const { reads } = readsWith((captured) =>
      captured.url.endsWith("/token")
        ? { status: 200, body: TOKEN }
        : { status: 404, body: "{}" },
    );
    expect(await reads.getBalance("ACC-1")).toBeUndefined();
  });

  it("retries a 5xx and then reports it as an API error", async () => {
    let attempts = 0;
    const { reads } = readsWith((captured) => {
      if (captured.url.endsWith("/token")) return { status: 200, body: TOKEN };
      attempts += 1;
      return { status: 503, body: "{}" };
    });
    await expect(reads.getBalance("ACC-1")).rejects.toThrow(RuyaApiError);
    expect(attempts).toBe(CONFIG.maxRetries + 1);
  });

  it("separates an unreachable bank from a refusal", async () => {
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) =>
      urlOf(input).endsWith("/token")
        ? Promise.resolve(
            new Response(TOKEN, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        : Promise.reject(new Error("ETIMEDOUT"))) as typeof fetch;
    const clock = new TestClock(START);
    const reads = new RuyaReads(new RuyaHttp(CONFIG, clock, fetchImpl), clock);
    await expect(reads.getBalance("ACC-1")).rejects.toThrow(RuyaTransportError);
  }, 20_000);
});
