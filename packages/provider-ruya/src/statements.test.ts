import { describe, expect, it } from "vitest";
import { TestClock, parseInstant } from "@baas/platform";
import { RuyaHttp } from "./http.js";
import {
  RuyaStatements,
  UnsafeODataValueError,
  odataIdentifier,
} from "./statements.js";
import type { RuyaConfig } from "./config.js";

const START = parseInstant("2026-09-27T17:00:00.000Z");
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
  maxRetries: 0,
};

const TOKEN = JSON.stringify({ access_token: "tok-1", expires_in: 3600 });

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function statementsWith(body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = urlOf(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      new Response(url.endsWith("/token") ? TOKEN : JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    statements: new RuyaStatements(
      new RuyaHttp(CONFIG, new TestClock(START), fetchImpl),
    ),
    calls,
  };
}

const ROWS = {
  value: [
    {
      gits_from: "2026-03-01",
      gits_to: "2026-03-31",
      gits_filename: "statement-2026-03.pdf",
      gits_securefilepath: "https://files.example/abc",
    },
    {
      gits_from: "2026-04-01T00:00:00Z",
      gits_to: "2026-04-30T00:00:00Z",
      gits_filename: "statement-2026-04.pdf",
      gits_securefilepath: "",
    },
  ],
};

describe("listing statement periods", () => {
  it("maps periods to calendar dates, not instants", async () => {
    const { statements } = statementsWith(ROWS);
    const list = await statements.listStatements({
      ownerReference: "CIF-1",
      accountReference: "ACC-1",
    });

    expect(list).toHaveLength(2);
    expect(list[0]?.from.toString()).toBe("2026-03-01");
    expect(list[0]?.to.toString()).toBe("2026-03-31");
    expect(list[0]?.available).toBe(true);
  });

  it("reports a period with no file as unavailable rather than hiding it", async () => {
    const { statements } = statementsWith(ROWS);
    const list = await statements.listStatements({
      ownerReference: "CIF-1",
      accountReference: "ACC-1",
    });
    expect(list[1]?.available).toBe(false);
  });

  it("takes only the date part of a timestamp", async () => {
    // BaNCS sends either form, and the time part is whatever its exporter
    // felt like.
    const { statements } = statementsWith(ROWS);
    const list = await statements.listStatements({
      ownerReference: "CIF-1",
      accountReference: "ACC-1",
    });
    expect(list[1]?.from.toString()).toBe("2026-04-01");
  });

  it("drops a row with no period rather than inventing one", async () => {
    const { statements } = statementsWith({
      value: [{ gits_filename: "orphan.pdf", gits_securefilepath: "x" }],
    });
    expect(
      await statements.listStatements({
        ownerReference: "CIF-1",
        accountReference: "ACC-1",
      }),
    ).toEqual([]);
  });

  it("sends none of the standard BaNCS headers on this endpoint", async () => {
    // Unlike every other Ruya call. Sending them produces an error that
    // mentions none of them.
    const { statements, calls } = statementsWith(ROWS);
    await statements.listStatements({
      ownerReference: "CIF-1",
      accountReference: "ACC-1",
    });
    const inquiry = calls.find((call) => call.url.includes("statementInquiry"));
    expect(inquiry?.headers["entity"]).toBeUndefined();
    expect(inquiry?.headers["channelId"]).toBeUndefined();
    expect(inquiry?.headers["Authorization"]).toBe("Bearer tok-1");
  });
});

describe("only identifiers reach the OData filter", () => {
  it.each(["CIF-1", "ACC_00123", "cif.42", "A1"])("accepts %o", (value) => {
    expect(odataIdentifier(value)).toBe(value);
  });

  it.each([
    "CIF-1' or gits_cif ne '",
    "CIF-1) and (1 eq 1",
    "CIF WITH SPACES",
    "O'Brien",
    "CIF\nother",
    "",
    "a".repeat(65),
  ])("refuses %o", (value) => {
    // Doubling the quote would neutralise the injection, and the first
    // version of this did exactly that. Allow-listing is stricter and
    // better: an identifier containing a quote or a space is not an
    // identifier, and rewriting it into a valid literal means querying for a
    // subtly different customer and showing the answer as fact.
    expect(() => odataIdentifier(value)).toThrow(UnsafeODataValueError);
  });

  it("refuses at the call site, before any request is made", async () => {
    const { statements, calls } = statementsWith(ROWS);
    await expect(
      statements.listStatements({
        ownerReference: "CIF-1' or '1' eq '1",
        accountReference: "ACC-1",
      }),
    ).rejects.toThrow(UnsafeODataValueError);
    expect(
      calls.filter((call) => call.url.includes("statementInquiry")),
    ).toEqual([]);
  });

  it("names the mechanism in the error, because this one is ours to read", () => {
    // Unlike a rejected cursor, which goes to a client and must stay opaque.
    expect(new UnsafeODataValueError("x").message).toMatch(/OData filter/);
  });
});
