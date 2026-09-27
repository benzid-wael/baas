import { describe, expect, it } from "vitest";
import { Duration } from "@baas/domain";
import { TestClock, parseInstant } from "@baas/platform";
import { KeelAccessTokens } from "./access-token.js";
import { jsonResponse } from "./testing.js";
import { KeelNotConfiguredError, KeelTransportError } from "./errors.js";
import type { KeelConfig } from "./config.js";

const START = parseInstant("2026-09-27T12:00:00.000Z");
const CONFIG: KeelConfig = {
  baseUrl: "https://sandbox.keel.example",
  clientId: "client",
  clientSecret: "secret",
  accessTokenEndpoint: "https://sandbox.keel.example/oauth/token",
  signingPrivateKeyPem: "unused",
  httpTimeoutMs: 5_000,
};

function tokenServer(expiresIn = 3600) {
  let issued = 0;
  const fetchImpl = (() => {
    issued += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: `tok-${issued.toString()}`,
          expires_in: expiresIn,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return { fetchImpl, issues: () => issued };
}

describe("token caching", () => {
  it("fetches once and reuses", async () => {
    const { fetchImpl, issues } = tokenServer();
    const tokens = new KeelAccessTokens(new TestClock(START), fetchImpl);
    expect(await tokens.bearerToken(CONFIG)).toBe("tok-1");
    expect(await tokens.bearerToken(CONFIG)).toBe("tok-1");
    expect(issues()).toBe(1);
  });

  it("refreshes a minute before expiry, not at it", async () => {
    // A token that expires mid-flight fails a call that looked fine when it
    // started.
    const clock = new TestClock(START);
    const { fetchImpl, issues } = tokenServer(3600);
    const tokens = new KeelAccessTokens(clock, fetchImpl);
    await tokens.bearerToken(CONFIG);

    clock.advanceBy(Duration.ofSeconds(3600 - 61));
    expect(await tokens.bearerToken(CONFIG)).toBe("tok-1");

    clock.advanceBy(Duration.ofSeconds(2));
    expect(await tokens.bearerToken(CONFIG)).toBe("tok-2");
    expect(issues()).toBe(2);
  });

  it("de-duplicates concurrent cold starts", async () => {
    // Without this, N concurrent requests on a cold start fetch N tokens, and
    // token endpoints are usually rate-limited far harder than the API.
    const { fetchImpl, issues } = tokenServer();
    const tokens = new KeelAccessTokens(new TestClock(START), fetchImpl);
    const all = await Promise.all([
      tokens.bearerToken(CONFIG),
      tokens.bearerToken(CONFIG),
      tokens.bearerToken(CONFIG),
    ]);
    expect(new Set(all).size).toBe(1);
    expect(issues()).toBe(1);
  });

  it("does not serve a token minted for rotated credentials", async () => {
    const { fetchImpl, issues } = tokenServer();
    const tokens = new KeelAccessTokens(new TestClock(START), fetchImpl);
    await tokens.bearerToken(CONFIG);
    expect(
      await tokens.bearerToken({ ...CONFIG, clientSecret: "rotated" }),
    ).toBe("tok-2");
    expect(issues()).toBe(2);
  });

  it("honours a pre-issued token without calling the endpoint", async () => {
    const { fetchImpl, issues } = tokenServer();
    const tokens = new KeelAccessTokens(new TestClock(START), fetchImpl);
    expect(await tokens.bearerToken({ ...CONFIG, bearerToken: "static" })).toBe(
      "static",
    );
    expect(issues()).toBe(0);
  });

  it("clamps a suspiciously short expiry to a minute", async () => {
    const clock = new TestClock(START);
    const { fetchImpl } = tokenServer(1);
    const tokens = new KeelAccessTokens(clock, fetchImpl);
    await tokens.bearerToken(CONFIG);
    // Without the clamp the safety margin would make every token instantly
    // stale, and every call would fetch a new one.
    expect(await tokens.bearerToken(CONFIG)).toBe("tok-2");
  });

  it("says so when it is not configured, rather than failing at the API", async () => {
    const tokens = new KeelAccessTokens(new TestClock(START));
    await expect(
      tokens.bearerToken({ ...CONFIG, clientSecret: "" }),
    ).rejects.toThrow(KeelNotConfiguredError);
  });

  it("reports a token endpoint that refuses as a transport failure", async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse({ error: "nope" }, 503))) as typeof fetch;
    await expect(
      new KeelAccessTokens(new TestClock(START), fetchImpl).bearerToken(CONFIG),
    ).rejects.toThrow(KeelTransportError);
  });

  it("reports a token response with no token", async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse({ token_type: "Bearer" }))) as typeof fetch;
    await expect(
      new KeelAccessTokens(new TestClock(START), fetchImpl).bearerToken(CONFIG),
    ).rejects.toThrow(/no access_token/);
  });
});
