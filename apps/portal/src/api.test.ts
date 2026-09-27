import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "./api.js";
import type { PortalConfig } from "./config.js";

const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * A fetch whose answer can change between calls, because the cases worth
 * testing here are all "it worked, and then it did not".
 */
function server(
  responder: (call: number) => { status: number; body?: unknown } | Error,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const answer = responder(calls.length);
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return Promise.resolve(
      new Response(
        answer.status === 204 ? null : JSON.stringify(answer.body ?? {}),
        {
          status: answer.status,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** The same answer every time. */
function respond(
  status: number,
  body: unknown = {},
): { fetchImpl: typeof fetch; calls: Call[] } {
  return server(() => ({ status, body }));
}

const SESSION = { token: "sess-1", expiresAt: "2026-09-29T00:00:00.000Z" };

/** A client that has signed in, and the calls it made doing so. */
async function signedIn(
  responder: (
    call: number,
  ) => { status: number; body?: unknown } | Error = () => ({
    status: 200,
  }),
): Promise<{ api: ApiClient; calls: Call[] }> {
  const { fetchImpl, calls } = server((call) =>
    call === 1 ? { status: 201, body: SESSION } : responder(call - 1),
  );
  const api = new ApiClient(CONFIG, fetchImpl);
  await api.signIn("id-token");
  return { api, calls };
}

describe("signing in", () => {
  it("exchanges an identity-provider token for a session", async () => {
    const { fetchImpl, calls } = respond(201, {
      token: "sess-1",
      expiresAt: "2026-09-29T00:00:00.000Z",
    });
    const api = new ApiClient(CONFIG, fetchImpl);
    await api.signIn("id-token");

    expect(api.signedIn).toBe(true);
    expect(calls[0]?.url).toBe("https://baas.example/operator/sessions");
    expect(calls[0]?.init.body).toContain("id-token");
  });

  it("sends the session as a bearer token once it has one", async () => {
    const { api, calls } = await signedIn();
    await api.get("/platform/system");

    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sess-1");
  });

  it("never sends a credential before there is a session", async () => {
    const { fetchImpl, calls } = respond(200, {});
    await new ApiClient(CONFIG, fetchImpl).get("/platform/system");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });
});

describe("signing out", () => {
  it("tells the server, then forgets the session", async () => {
    const { api, calls } = await signedIn(() => ({ status: 204 }));
    await api.signOut();
    expect(calls[1]?.url).toBe(
      "https://baas.example/operator/sessions/current",
    );
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(api.signedIn).toBe(false);
  });

  it("forgets the session even when the request fails", async () => {
    // A sign-out that leaves the token in the tab because the network blipped
    // is not a sign-out.
    const { api } = await signedIn(() => new Error("offline"));
    await expect(api.signOut()).rejects.toThrow("offline");
    expect(api.signedIn).toBe(false);
  });

  it("does nothing when there is no session", async () => {
    const { fetchImpl, calls } = respond(204);
    await new ApiClient(CONFIG, fetchImpl).signOut();
    expect(calls).toEqual([]);
  });
});

describe("what the operator is told when something fails", () => {
  it("drops the session on a 401, so the next render asks them to sign in", async () => {
    // Revoked, expired, or the server restarted. Keeping the dead token would
    // show a wall of failing requests instead of a sign-in screen.
    const { api } = await signedIn(() => ({ status: 401 }));
    expect(api.signedIn).toBe(true);

    await expect(api.get("/platform/system")).rejects.toThrow(ApiError);
    expect(api.signedIn).toBe(false);
  });

  it("shows our wording, never the server's", async () => {
    // Finding F3: the incumbent's portal renders a provider's error text into
    // the page. It is unreadable, and a bank's phrasing sometimes carries an
    // account number onto a screen and into a screenshot.
    const leak = "IBAN AE070331234567890123456 is closed";
    const { fetchImpl } = respond(500, { message: leak });
    try {
      await new ApiClient(CONFIG, fetchImpl).get("/platform/system");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message).not.toContain(leak);
      expect((error as Error).message).toContain("at our end");
    }
  });

  it("distinguishes forbidden from not found", async () => {
    await expect(
      new ApiClient(CONFIG, respond(403).fetchImpl).get("/x"),
    ).rejects.toThrow(/permission/);
    await expect(
      new ApiClient(CONFIG, respond(404).fetchImpl).get("/x"),
    ).rejects.toThrow(/Not found/);
  });
});
