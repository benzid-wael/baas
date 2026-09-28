import { describe, expect, it } from "vitest";
import { OidcError, beginSignIn, completeSignIn, discover } from "./oidc.js";
import type { FlowStore } from "./oidc.js";
import type { PortalConfig } from "./config.js";

const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example/baas",
  oidcClientId: "baas-portal",
};
const REDIRECT = "https://portal.example/";

const DISCOVERY = {
  authorization_endpoint: "https://idp.example/baas/authorize",
  token_endpoint: "https://idp.example/baas/token",
};

function memoryStore(initial: Record<string, string> = {}): FlowStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

interface Exchange {
  url: string;
  init: RequestInit | undefined;
}

function server(
  responder: (url: string) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Exchange[] } {
  const calls: Exchange[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = responder(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const working = (): ReturnType<typeof server> =>
  server((url) =>
    url.includes("openid-configuration")
      ? { status: 200, body: DISCOVERY }
      : { status: 200, body: { id_token: "the-id-token", access_token: "a" } },
  );

describe("discovery", () => {
  it("asks the provider where its endpoints are", async () => {
    const { fetchImpl, calls } = working();
    expect(await discover(CONFIG.oidcIssuer, fetchImpl)).toEqual({
      authorization: DISCOVERY.authorization_endpoint,
      token: DISCOVERY.token_endpoint,
    });
    expect(calls[0]?.url).toBe(
      "https://idp.example/baas/.well-known/openid-configuration",
    );
  });

  it("refuses a configuration that is missing an endpoint", async () => {
    const { fetchImpl } = server(() => ({ status: 200, body: {} }));
    await expect(discover(CONFIG.oidcIssuer, fetchImpl)).rejects.toThrow(
      OidcError,
    );
  });

  it("refuses a provider that cannot be reached", async () => {
    const { fetchImpl } = server(() => ({ status: 503, body: {} }));
    await expect(discover(CONFIG.oidcIssuer, fetchImpl)).rejects.toThrow(
      /could not be reached/,
    );
  });
});

describe("starting the flow", () => {
  it("builds an authorization URL with a challenge and no secret", async () => {
    const store = memoryStore();
    const url = new URL(
      await beginSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store,
        fetchImpl: working().fetchImpl,
      }),
    );

    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("baas-portal");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    // A browser cannot hold a secret, so it must not carry one.
    expect(url.searchParams.get("client_secret")).toBeNull();
  });

  it("never puts the verifier in the URL", async () => {
    // The whole point: the verifier is the thing that never crosses the wire
    // until redemption. In the authorization URL it would be pointless.
    const store = memoryStore();
    const url = await beginSignIn({
      config: CONFIG,
      redirectUri: REDIRECT,
      store,
      fetchImpl: working().fetchImpl,
    });
    const verifier = store.get("baas.pkce.verifier");
    expect(verifier).toBeTruthy();
    expect(url).not.toContain(verifier ?? "never");
  });

  it("remembers the state it will check on the way back", async () => {
    const store = memoryStore();
    const url = new URL(
      await beginSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store,
        fetchImpl: working().fetchImpl,
      }),
    );
    expect(url.searchParams.get("state")).toBe(store.get("baas.pkce.state"));
  });
});

describe("finishing the flow", () => {
  const stored = (): FlowStore =>
    memoryStore({
      "baas.pkce.verifier": "the-verifier",
      "baas.pkce.state": "the-state",
    });

  const callback = (
    params: Record<string, string> = { code: "the-code", state: "the-state" },
  ): URLSearchParams => new URLSearchParams(params);

  it("redeems the code with the verifier and returns the ID token", async () => {
    const { fetchImpl, calls } = working();
    const token = await completeSignIn({
      config: CONFIG,
      redirectUri: REDIRECT,
      store: stored(),
      params: callback(),
      fetchImpl,
    });

    expect(token).toBe("the-id-token");
    const exchange = calls.find((call) => call.url.endsWith("/token"));
    const body = new URLSearchParams(
      typeof exchange?.init?.body === "string" ? exchange.init.body : "",
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("client_secret")).toBeNull();
  });

  it("refuses a state that does not match", async () => {
    // Somebody delivered a code to this redirect that this tab did not ask
    // for. Redeeming it would sign the operator in as someone else.
    await expect(
      completeSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store: stored(),
        params: callback({ code: "c", state: "a-different-state" }),
        fetchImpl: working().fetchImpl,
      }),
    ).rejects.toThrow(/did not start here/);
  });

  it("refuses a callback when nothing was started here", async () => {
    await expect(
      completeSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store: memoryStore(),
        params: callback(),
        fetchImpl: working().fetchImpl,
      }),
    ).rejects.toThrow(/did not start here/);
  });

  it("discards the verifier even when the exchange fails", async () => {
    // A verifier that survives a failed attempt is a verifier available for a
    // second one.
    const store = stored();
    const { fetchImpl } = server((url) =>
      url.includes("openid-configuration")
        ? { status: 200, body: DISCOVERY }
        : { status: 400, body: { error: "invalid_grant" } },
    );
    await expect(
      completeSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store,
        params: callback(),
        fetchImpl,
      }),
    ).rejects.toThrow(OidcError);
    expect(store.get("baas.pkce.verifier")).toBeNull();
    expect(store.get("baas.pkce.state")).toBeNull();
  });

  it("does not repeat the provider's error code back to the operator", async () => {
    // `login_required` on a screen helps nobody, and a provider's error text
    // is not written for a person.
    await expect(
      completeSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store: stored(),
        params: callback({ error: "login_required", state: "the-state" }),
        fetchImpl: working().fetchImpl,
      }),
    ).rejects.toThrow(/^Sign-in was not completed\.$/);
  });

  it("refuses a token response with no identity in it", async () => {
    const { fetchImpl } = server((url) =>
      url.includes("openid-configuration")
        ? { status: 200, body: DISCOVERY }
        : { status: 200, body: { access_token: "only-this" } },
    );
    await expect(
      completeSignIn({
        config: CONFIG,
        redirectUri: REDIRECT,
        store: stored(),
        params: callback(),
        fetchImpl,
      }),
    ).rejects.toThrow(/no identity/);
  });
});
