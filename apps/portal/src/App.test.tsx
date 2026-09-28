import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { ApiClient } from "./api.js";
import type { FlowStore } from "./oidc.js";
import type { PortalConfig } from "./config.js";

/**
 * The shell, end to end within the browser (MP-6, MP-7a).
 *
 * Finding E3: the incumbent's frontend has no unit test framework — only
 * Playwright smokes that are not installed by default, so nothing runs. These
 * need no browser installed and no server running, and they exercise the whole
 * sign-in path: authorization URL, callback, token exchange, session.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example/baas",
  oidcClientId: "baas-portal",
};

const DISCOVERY = {
  authorization_endpoint: "https://idp.example/baas/authorize",
  token_endpoint: "https://idp.example/baas/token",
};

const SYSTEM_STATE = {
  migrations: { applied: ["0001_core.sql"] },
  schema: { matches: true, undeclared: [], missing: [] },
  outbox: { unresolved: 0, depths: [] },
  inbox: { unprocessed: 0, rejectedSignatures: 0 },
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

/** One fetch standing in for both the identity provider and the API. */
function world(overrides: { token?: unknown; system?: unknown } = {}) {
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes("openid-configuration")
      ? DISCOVERY
      : url.endsWith("/token")
        ? (overrides.token ?? { id_token: "the-id-token" })
        : url.endsWith("/operator/sessions")
          ? { token: "sess-1", expiresAt: "2026-09-29T00:00:00.000Z" }
          : (overrides.system ?? SYSTEM_STATE);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: url.endsWith("/operator/sessions") ? 201 : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, api: new ApiClient(CONFIG, fetchImpl) };
}

function mount(
  options: {
    search?: string;
    store?: FlowStore;
    api?: ApiClient;
    navigate?: (url: string) => void;
  } = {},
) {
  const { api, fetchImpl } = world();
  const navigate = options.navigate ?? vi.fn();
  const clearQuery = vi.fn();
  render(
    <App
      api={options.api ?? api}
      config={CONFIG}
      store={options.store ?? memoryStore()}
      location={{
        href: `https://portal.example/${options.search ?? ""}`,
        search: options.search ?? "",
      }}
      navigate={navigate}
      clearQuery={clearQuery}
      fetchImpl={fetchImpl}
    />,
  );
  return { navigate, clearQuery };
}

describe("signed out", () => {
  it("offers sign-in and never asks for a password", () => {
    mount();
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined();
    // The portal performs the authorization-code flow. A password field here
    // would mean it had started handling credentials, which it must never do.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("sends the browser to the provider, with a challenge and no secret", async () => {
    const { navigate } = mount();
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    const url = new URL(String(vi.mocked(navigate).mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    // The redirect URI is derived from the page, so the two halves of the
    // flow cannot disagree about it.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://portal.example/",
    );
  });
});

describe("coming back from the provider", () => {
  const started = (): FlowStore =>
    memoryStore({
      "baas.pkce.verifier": "the-verifier",
      "baas.pkce.state": "the-state",
    });

  it("redeems the code, gets a session, and shows the console", async () => {
    mount({ search: "?code=the-code&state=the-state", store: started() });
    expect(
      await screen.findByRole("heading", { name: /system/i }),
    ).toBeDefined();
  });

  it("takes the code out of the URL", async () => {
    // A code left in the address bar is a code in history and in the next
    // screenshot.
    const { clearQuery } = mount({
      search: "?code=the-code&state=the-state",
      store: started(),
    });
    await vi.waitFor(() => {
      expect(clearQuery).toHaveBeenCalled();
    });
  });

  it("refuses a callback this tab did not start, and says so", async () => {
    mount({ search: "?code=the-code&state=somebody-elses", store: started() });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/did not start here/),
    );
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined();
  });

  it("shows nothing of the provider's own error wording", async () => {
    mount({
      search: "?error=login_required&state=the-state",
      store: started(),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("login_required");
  });
});

describe("signed in", () => {
  async function signedIn(): Promise<void> {
    mount({
      search: "?code=the-code&state=the-state",
      store: memoryStore({
        "baas.pkce.verifier": "v",
        "baas.pkce.state": "the-state",
      }),
    });
    await screen.findByRole("heading", { name: /system/i });
  }

  it("shows the system state the session fetched", async () => {
    await signedIn();
    expect(screen.getByText(/matches the declaration/i)).toBeDefined();
  });

  it("signs out and returns to the prompt", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(
      await screen.findByRole("heading", { name: /sign in/i }),
    ).toBeDefined();
  });
});
